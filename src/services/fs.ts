import { spawn } from "child_process";
import { homedir } from "os";
import * as nodePath from "path";
import { FileSystem } from "@effect/platform";
import { Effect, Layer } from "effect";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";

/**
 * filesystem context service that tracks a working directory per agent/conversation.
 * Falls back to process.cwd() when no directory was set.
 */
export function createFileSystemContextServiceLayer(): Layer.Layer<
  FileSystemContextService,
  never,
  FileSystem.FileSystem
> {
  return Layer.effect(
    FileSystemContextServiceTag,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = homedir();

      // Map key: agentId.conversationId? -> cwd
      const cwdByKey = new Map<string, string>();

      function makeKey(key: { agentId: string; conversationId?: string }): string {
        return key.conversationId ? `${key.agentId}:${key.conversationId}` : key.agentId;
      }

      function normalize(p: string): string {
        // Handle quoted paths first: '"Application Support"' -> 'Application Support'
        let normalized = p;
        if (
          (normalized.startsWith('"') && normalized.endsWith('"')) ||
          (normalized.startsWith("'") && normalized.endsWith("'"))
        ) {
          normalized = normalized.slice(1, -1);
        }

        if (normalized === "~") {
          normalized = home;
        } else if (normalized.startsWith("~/")) {
          normalized = nodePath.join(home, normalized.slice(2));
        }

        // Remove shell escaping for all characters (spaces, path separators, etc.)
        // Handle backslash-escaped characters: "Application\\ Support" -> "Application Support"
        // Handle backslash-escaped path separators: "path\\to\\file" -> "path/to/file"
        normalized = normalized.replace(/\\(.)/g, "$1");

        return normalized;
      }

      function escapeForShell(path: string): string {
        // Escape paths for safe use in shell commands
        // If the path contains spaces or special characters, wrap in quotes
        if (
          path.includes(" ") ||
          path.includes("(") ||
          path.includes(")") ||
          path.includes("&") ||
          path.includes("|")
        ) {
          // If already quoted, don't double-quote
          if (
            (path.startsWith('"') && path.endsWith('"')) ||
            (path.startsWith("'") && path.endsWith("'"))
          ) {
            return path;
          }

          return `"${path.replace(/"/g, '\\"')}"`;
        }

        return path;
      }

      function findDirectoryByName(
        startPath: string,
        targetName: string,
        maxDepth: number,
      ): Effect.Effect<{ results: readonly string[]; warnings?: readonly string[] }, Error, never> {
        return Effect.gen(function* () {
          // Use system find command for efficiency
          const command = `find ${escapeForShell(startPath)} -maxdepth ${maxDepth} -type d -iname "*${targetName}*"`;
          const result = yield* Effect.promise<{
            stdout: string;
            stderr: string;
            exitCode: number;
          }>(
            () =>
              new Promise((resolve, reject) => {
                const child = spawn("sh", ["-c", command], {
                  stdio: ["ignore", "pipe", "pipe"],
                  timeout: 10000,
                });

                let stdout = "";
                let stderr = "";

                if (child.stdout) {
                  child.stdout.on("data", (data: Buffer) => {
                    stdout += data.toString();
                  });
                }

                if (child.stderr) {
                  child.stderr.on("data", (data: Buffer) => {
                    stderr += data.toString();
                  });
                }

                child.on("close", (code: number | null) => {
                  resolve({
                    stdout: stdout.trim(),
                    stderr: stderr.trim(),
                    exitCode: code || 0,
                  });
                });

                child.on("error", (error: Error) => {
                  reject(error);
                });
              }),
          ).pipe(
            Effect.catchAll((error: Error) =>
              Effect.succeed({
                stdout: "",
                stderr: error.message,
                exitCode: 1,
              }),
            ),
          );

          // Parse results and sort
          const results = result.stdout
            .split("\n")
            .filter((line) => line.trim())
            .sort();

          const warnings: string[] = [];

          // If no results and exit code is non-zero, capture the error for LLM interpretation
          if (result.exitCode !== 0 && result.stderr) {
            warnings.push(`Find command encountered issues: ${result.stderr}`);
          }

          // If we got no results but no explicit error, provide context
          if (results.length === 0 && result.exitCode === 0) {
            warnings.push(
              `No directories found matching "${targetName}" in ${startPath} (max depth: ${maxDepth})`,
            );
          }

          return {
            results,
            ...(warnings.length > 0 && { warnings }),
          };
        });
      }

      const service: FileSystemContextService = {
        getCwd: (key) => Effect.sync(() => cwdByKey.get(makeKey(key)) ?? process.cwd()),

        setCwd: (key, path) =>
          Effect.gen(function* () {
            const target = normalize(path);
            // Check if the directory exists and is a directory
            const statResult = yield* fs
              .stat(target)
              .pipe(Effect.catchAll(() => Effect.succeed(null)));

            if (!statResult) {
              return yield* Effect.fail(new Error(`Directory does not exist: ${target}`));
            }

            const isDir = statResult.type === "Directory";
            if (!isDir) {
              return yield* Effect.fail(new Error(`Not a directory: ${target}`));
            }

            cwdByKey.set(makeKey(key), target);
          }),

        resolvePath: (key, path, options = {}) =>
          Effect.gen(function* () {
            const base = cwdByKey.get(makeKey(key)) ?? process.cwd();

            // Normalize the path first
            const normalizedPath = normalize(path);

            // Handle special cases: "." and ".."
            let resolved: string;
            if (normalizedPath === ".") {
              resolved = base;
            } else if (normalizedPath === "..") {
              // Go up one directory from base
              const parent = base.substring(0, base.lastIndexOf("/"));
              resolved = parent || "/";
            } else if (normalizedPath.startsWith("/")) {
              // Absolute path
              resolved = normalizedPath;
            } else {
              // Relative path - combine with base
              resolved = `${base}/${normalizedPath}`;
            }

            // Normalize the resolved path to remove . and .. components
            const cleanedPath = nodePath.normalize(resolved);

            // If skipExistenceCheck is true, return the resolved path without checking existence
            if (options.skipExistenceCheck) {
              return cleanedPath;
            }

            // Check if the resolved path exists
            const statResult = yield* fs
              .stat(cleanedPath)
              .pipe(Effect.catchAll(() => Effect.succeed(null)));

            if (statResult) {
              return cleanedPath;
            } else {
              // If it's a relative path and doesn't exist, try to find similar directories
              if (!normalizedPath.startsWith("/")) {
                const pathParts = normalizedPath.split("/");
                const targetName = pathParts[pathParts.length - 1];

                if (targetName) {
                  // Search for directories with similar names
                  const found = yield* findDirectoryByName(base, targetName, 3);
                  if (found.results.length > 0) {
                    const suggestion = found.results[0];
                    throw new Error(
                      `Path not found: ${cleanedPath}\n` +
                        `Did you mean: ${suggestion}?\n` +
                        `Found ${found.results.length} similar directory${found.results.length > 1 ? "ies" : "y"}: ${found.results.join(", ")}`,
                    );
                  }
                }
              }

              return yield* Effect.fail(new Error(`Path not found: ${cleanedPath}`));
            }
          }),

        findDirectory: (key, name, maxDepth = 3) =>
          Effect.gen(function* () {
            const base = cwdByKey.get(makeKey(key)) ?? process.cwd();
            return yield* findDirectoryByName(base, name, maxDepth);
          }),

        resolvePathForMkdir: (key, path) =>
          Effect.gen(function* () {
            const base = cwdByKey.get(makeKey(key)) ?? process.cwd();

            // Normalize the path first
            const normalizedPath = normalize(path);

            // Handle special cases: "." and ".."
            let resolved: string;
            if (normalizedPath === ".") {
              resolved = base;
            } else if (normalizedPath === "..") {
              // Go up one directory from base
              const parent = base.substring(0, base.lastIndexOf("/"));
              resolved = parent || "/";
            } else if (normalizedPath.startsWith("/")) {
              // Absolute path
              resolved = normalizedPath;
            } else {
              // Relative path - combine with base
              resolved = `${base}/${normalizedPath}`;
            }

            // Normalize the resolved path to remove . and .. components
            const cleanedPath = nodePath.normalize(resolved);

            // For mkdir, we need to check if the parent directory exists
            const parentDir = cleanedPath.substring(0, cleanedPath.lastIndexOf("/"));

            // If parentDir is empty, it means we're creating in root
            if (parentDir === "") {
              return cleanedPath;
            }

            // Check if the parent directory exists
            const parentStatResult = yield* fs
              .stat(parentDir)
              .pipe(Effect.catchAll(() => Effect.succeed(null)));

            if (!parentStatResult) {
              return yield* Effect.fail(
                new Error(
                  `Cannot create directory '${cleanedPath}': parent directory '${parentDir}' does not exist. Use recursive=true to create parent directories.`,
                ),
              );
            }

            if (parentStatResult.type !== "Directory") {
              return yield* Effect.fail(
                new Error(
                  `Cannot create directory '${cleanedPath}': '${parentDir}' is not a directory.`,
                ),
              );
            }

            return cleanedPath;
          }),

        escapePath: (path) => escapeForShell(path),
      };

      return service;
    }),
  );
}
