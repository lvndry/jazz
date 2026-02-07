import { spawn } from "child_process";
import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { Tool } from "@/core/interfaces/tool-registry";
import { createSanitizedEnv } from "@/core/utils/env-utils";
import { defineTool } from "../base-tool";
import { buildKeyFromContext } from "../context-utils";

/**
 * Search file contents with patterns tool (uses ripgrep when available, falls back to grep)
 */

// Cache ripgrep availability check — avoids spawning `rg --version` on every call
let ripgrepAvailable: boolean | null = null;

function checkRipgrepAvailable(): Promise<boolean> {
  if (ripgrepAvailable !== null) return Promise.resolve(ripgrepAvailable);
  return new Promise((resolve) => {
    const child = spawn("rg", ["--version"], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 5_000,
    });
    child.on("close", (code) => {
      ripgrepAvailable = code === 0;
      resolve(ripgrepAvailable);
    });
    child.on("error", () => {
      ripgrepAvailable = false;
      resolve(false);
    });
  });
}

export function createGrepTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      pattern: z.string().min(1).describe("Search pattern (literal or 're:<regex>')"),
      path: z.string().optional().describe("File or directory to search (defaults to cwd)"),
      recursive: z.boolean().optional().describe("Recurse into directories"),
      regex: z.boolean().optional().describe("Treat pattern as regex (overrides re:<...>)"),
      ignoreCase: z.boolean().optional().describe("Case-insensitive match"),
      maxResults: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Max matches to return (default: 200, hard cap: 2000). Use smaller values and narrow paths first.",
        ),
      filePattern: z
        .string()
        .optional()
        .describe("File pattern to search in (e.g., '*.js', '*.ts'). Uses glob filter."),
      exclude: z
        .string()
        .optional()
        .describe(
          "Exclude files matching this pattern (e.g., '*.min.js', '*.log').",
        ),
      excludeDir: z
        .string()
        .optional()
        .describe(
          "Exclude directories matching this pattern (e.g., 'node_modules', '.git').",
        ),
      contextLines: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Number of context lines to show above and below each match. Use this to see surrounding content when searching for patterns.",
        ),
      outputMode: z
        .enum(["content", "files", "count"])
        .optional()
        .describe(
          "Output mode: 'content' returns matching lines (default), 'files' returns only file paths, 'count' returns match counts per file.",
        ),
    })
    .strict();

  type GrepArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GrepArgs>({
    name: "grep",
    description:
      "Search for text patterns within file contents using ripgrep (rg). Multi-threaded, respects .gitignore, and supports literal strings and regex patterns. Use to find specific code, text, or patterns across files. Returns matching lines with file paths and line numbers by default. Use outputMode 'files' for file paths only (minimal tokens) or 'count' for match counts per file. Defaults to 200 results (hard cap 2000). **Tip: Start with narrow paths or filePattern, then read specific files if needed.**",
    tags: ["search", "text"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? {
            valid: true,
            value: params.data,
          }
        : { valid: false, errors: params.error.issues.map((i) => i.message) };
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const shell = yield* FileSystemContextServiceTag;
        const start = args.path
          ? yield* shell.resolvePath(buildKeyFromContext(context), args.path)
          : yield* shell.getCwd(buildKeyFromContext(context));
        const recursive = args.recursive !== false;
        const requestedMaxResults =
          typeof args.maxResults === "number" && args.maxResults > 0 ? args.maxResults : 200;
        const maxResults = Math.min(requestedMaxResults, 2000);
        const outputMode = args.outputMode ?? "content";

        // Check if the path exists and determine if it's a file or directory
        const stat = yield* fs.stat(start).pipe(Effect.catchAll(() => Effect.succeed(null)));

        if (stat === null) {
          return yield* Effect.fail(new Error(`Path does not exist: ${start}`));
        }

        // Determine the working directory and search path
        let workingDir: string;
        let searchPath: string;

        if (stat.type === "Directory") {
          workingDir = start;
          searchPath = start;
        } else if (stat.type === "File") {
          // If it's a file, use its parent directory as working directory and the file as search path
          const pathModule = yield* Effect.promise(() => import("path"));
          workingDir = pathModule.dirname(start);
          searchPath = start;
        } else {
          workingDir = start;
          searchPath = start;
        }

        // Try ripgrep first, fall back to grep (result is cached after first check)
        const useRipgrep = yield* Effect.promise(() => checkRipgrepAvailable());

        const cmdArgs: string[] = [];
        let cmd: string;

        if (useRipgrep) {
          cmd = "rg";

          // ripgrep is recursive by default; use --no-recursive for non-recursive
          if (!recursive || stat.type === "File") {
            // When searching a single file, rg handles it naturally
            if (stat.type === "Directory" && !recursive) {
              cmdArgs.push("--max-depth", "1");
            }
          }

          // Case sensitivity
          if (args.ignoreCase) {
            cmdArgs.push("-i");
          }

          // Output mode flags
          if (outputMode === "files") {
            cmdArgs.push("-l");
          } else if (outputMode === "count") {
            cmdArgs.push("-c");
          } else {
            // content mode: line numbers
            cmdArgs.push("-n");
          }

          // Context lines (only for content mode)
          if (outputMode === "content" && typeof args.contextLines === "number" && args.contextLines > 0) {
            cmdArgs.push("-C", args.contextLines.toString());
          }

          // File pattern (glob filter)
          if (args.filePattern) {
            cmdArgs.push("-g", args.filePattern);
          }

          // Exclude file pattern
          if (args.exclude) {
            cmdArgs.push("-g", `!${args.exclude}`);
          }

          // Exclude directory pattern
          if (args.excludeDir) {
            cmdArgs.push("-g", `!${args.excludeDir}/`);
          }

          // Max count
          cmdArgs.push("-m", maxResults.toString());

          // Determine if pattern is regex
          let searchPattern: string;
          if (args.regex === true || args.pattern.startsWith("re:")) {
            const source = args.regex === true ? args.pattern : args.pattern.slice(3) || "";
            searchPattern = source;
            // rg uses regex by default, no flag needed
          } else {
            searchPattern = args.pattern;
            cmdArgs.push("--fixed-strings");
          }

          // Add the search pattern and path
          cmdArgs.push(searchPattern, searchPath);
        } else {
          // Fallback to grep
          cmd = "grep";

          // Add recursive flag (only if searching a directory)
          if (recursive && stat.type === "Directory") {
            cmdArgs.push("-r");
          }

          // Case sensitivity
          if (args.ignoreCase) {
            cmdArgs.push("-i");
          }

          // Output mode flags
          if (outputMode === "files") {
            cmdArgs.push("-l");
          } else if (outputMode === "count") {
            cmdArgs.push("-c");
          } else {
            // content mode: line numbers
            cmdArgs.push("-n");
          }

          // Context lines (only for content mode)
          if (outputMode === "content" && typeof args.contextLines === "number" && args.contextLines > 0) {
            cmdArgs.push("-C", args.contextLines.toString());
          }

          // File pattern
          if (args.filePattern) {
            cmdArgs.push("--include", args.filePattern);
          }

          // Exclude file pattern
          if (args.exclude) {
            cmdArgs.push("--exclude", args.exclude);
          }

          // Exclude directory pattern
          if (args.excludeDir) {
            cmdArgs.push("--exclude-dir", args.excludeDir);
          }

          // Max count
          cmdArgs.push("-m", maxResults.toString());

          // Determine if pattern is regex
          let searchPattern: string;
          if (args.regex === true || args.pattern.startsWith("re:")) {
            const source = args.regex === true ? args.pattern : args.pattern.slice(3) || "";
            searchPattern = source;
            cmdArgs.push("-E");
          } else {
            searchPattern = args.pattern;
            cmdArgs.push("-F");
          }

          // Add the search pattern and path
          cmdArgs.push(searchPattern, searchPath);
        }

        // Execute the command using proper argument passing (no shell injection risk)
        const result = yield* Effect.promise<{
          stdout: string;
          stderr: string;
          exitCode: number;
        }>(
          () =>
            new Promise((resolve, reject) => {
              const sanitizedEnv = createSanitizedEnv();
              const child = spawn(cmd, cmdArgs, {
                cwd: workingDir,
                stdio: ["ignore", "pipe", "pipe"],
                env: sanitizedEnv,
                timeout: 30_000,
                detached: false,
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

        // Both rg and grep return exit code 1 when no matches are found, which is normal
        if (result.exitCode !== 0 && result.exitCode !== 1) {
          return {
            success: false,
            result: null,
            error: `${cmd} command failed: ${result.stderr}`,
          };
        }

        // Handle different output modes
        if (outputMode === "files") {
          const files = result.stdout
            .split("\n")
            .filter((line) => line.trim())
            .slice(0, maxResults);

          return {
            success: true,
            result: {
              pattern: args.pattern,
              searchPath: start,
              outputMode,
              files,
              totalFound: files.length,
              message:
                files.length === 0
                  ? `No files found matching pattern "${args.pattern}"`
                  : `Found ${files.length} files matching pattern "${args.pattern}"`,
            },
          };
        }

        if (outputMode === "count") {
          const counts: Array<{ file: string; count: number }> = [];
          const lines = result.stdout.split("\n").filter((line) => line.trim());

          for (const line of lines) {
            // Format: file:count
            const lastColon = line.lastIndexOf(":");
            if (lastColon > 0) {
              const file = line.slice(0, lastColon);
              const count = parseInt(line.slice(lastColon + 1), 10);
              if (!isNaN(count) && count > 0) {
                counts.push({ file, count });
              }
            }
          }

          return {
            success: true,
            result: {
              pattern: args.pattern,
              searchPath: start,
              outputMode,
              counts: counts.slice(0, maxResults),
              totalFound: counts.length,
              message:
                counts.length === 0
                  ? `No matches found for pattern "${args.pattern}"`
                  : `Found matches in ${counts.length} files for pattern "${args.pattern}"`,
            },
          };
        }

        // Default: content mode
        // Parse results
        // When contextLines is used, grep/rg adds "--" separators between match groups
        const lines = result.stdout.split("\n").filter((line) => line.trim());
        const matches: Array<{ file: string; line: number; text: string }> = [];
        const seenMatches = new Set<string>(); // Track unique file:line combinations to avoid duplicates

        for (const line of lines) {
          // Skip separator lines added by -C
          if (line === "--") continue;

          // Parse format: file:line:content
          const parts = line.split(":");
          if (parts.length >= 3 && parts[0] && parts[1]) {
            const file = parts[0];
            const lineNum = parseInt(parts[1], 10);
            const text = parts.slice(2).join(":");
            const key = `${file}:${lineNum}`;

            // Avoid duplicate matches when context lines are used
            if (!seenMatches.has(key)) {
              seenMatches.add(key);
              matches.push({
                file,
                line: lineNum,
                text,
              });
            }
          }
        }

        return {
          success: true,
          result: {
            pattern: args.pattern,
            searchPath: start,
            recursive,
            regex: args.regex === true || args.pattern.startsWith("re:"),
            ignoreCase: args.ignoreCase,
            filePattern: args.filePattern,
            exclude: args.exclude,
            excludeDir: args.excludeDir,
            contextLines: args.contextLines,
            outputMode,
            matches: matches.slice(0, maxResults),
            totalFound: matches.length,
            message:
              matches.length === 0
                ? `No matches found for pattern "${args.pattern}"`
                : `Found ${matches.length} matches for pattern "${args.pattern}"${
                    args.contextLines ? ` (with ${args.contextLines} context lines)` : ""
                  }${requestedMaxResults > maxResults ? ` (capped at ${maxResults})` : ""}`,
          },
        };
      }),
  });
}
