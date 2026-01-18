import { FileSystem } from "@effect/platform";
import { spawn } from "child_process";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "../../../interfaces/fs";
import type { Tool } from "../../../interfaces/tool-registry";
import { createSanitizedEnv } from "../../../utils/env-utils";
import { defineTool } from "../base-tool";
import { buildKeyFromContext } from "../context-utils";
import { normalizeFilterPattern } from "./utils";

/**
 * Find files and directories tool
 */

export function createFindTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z.string().optional().describe("Start directory (defaults to smart search)"),
      name: z.string().optional().describe("Filter by name (substring or 're:<regex>')"),
      type: z.enum(["file", "dir", "all"]).optional().describe("Type filter"),
      maxDepth: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Maximum depth to traverse (0=current dir)"),
      maxResults: z.number().int().positive().optional().describe("Maximum results to return"),
      includeHidden: z.boolean().optional().describe("Include dotfiles and dot-directories"),
      smart: z
        .boolean()
        .optional()
        .describe("Use smart hierarchical search (HOME first, then expand)"),
    })
    .strict();

  type FindArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, FindArgs>({
    name: "find",
    description:
      "Advanced file and directory search with smart hierarchical search strategy (searches cwd, home, and parent directories in order). Supports deep traversal (default 25 levels), regex patterns, type filters, and hidden files. Use for comprehensive searches when find_path doesn't locate what you need.",
    tags: ["filesystem", "search"],
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
        const shell = yield* FileSystemContextServiceTag;

        const includeHidden = args.includeHidden === true;
        const maxResults =
          typeof args.maxResults === "number" && args.maxResults > 0 ? args.maxResults : 5000;
        const maxDepth = typeof args.maxDepth === "number" ? args.maxDepth : 25;
        const typeFilter = args.type ?? "all";
        const useSmart = args.smart !== false;

        // Smart search strategy: search in order of likelihood
        const searchPaths: string[] = [];

        if (args.path) {
          // If path is specified, use it directly
          const start = yield* shell.resolvePath(buildKeyFromContext(context), args.path);
          searchPaths.push(start);
        } else if (useSmart) {
          // Smart search: start with most likely locations
          const home = process.env["HOME"] || "";
          const cwd = yield* shell.getCwd(buildKeyFromContext(context));

          // 1. Current working directory (most likely)
          if (cwd && cwd !== home) {
            searchPaths.push(cwd);
          }

          // 2. Home directory (very likely)
          if (home) {
            searchPaths.push(home);
          }

          // 3. Parent directories (up to 3 levels up from cwd)
          let currentPath = cwd;
          for (let i = 0; i < 3; i++) {
            const parent = currentPath.split("/").slice(0, -1).join("/");
            if (parent && parent !== currentPath && parent !== "/") {
              searchPaths.push(parent);
              currentPath = parent;
            } else {
              break;
            }
          }
        } else {
          // Traditional search: start from current directory
          const start = yield* shell.getCwd(buildKeyFromContext(context));
          searchPaths.push(start);
        }

        const allResults: { path: string; name: string; type: "file" | "dir" }[] = [];

        // Search each path in order using system find command
        for (const searchPath of searchPaths) {
          if (allResults.length >= maxResults) break;

          // Build find command arguments
          const findArgs: string[] = [searchPath];

          // Add max depth
          findArgs.push("-maxdepth", maxDepth.toString());

          // Add type filter
          if (typeFilter === "dir") {
            findArgs.push("-type", "d");
          } else if (typeFilter === "file") {
            findArgs.push("-type", "f");
          }

          // Add name pattern if specified
          if (args.name) {
            const filter = normalizeFilterPattern(args.name);
            if (filter.type === "regex" && filter.regex) {
              findArgs.push("-regex", filter.regex.source);
            } else if (filter.value) {
              findArgs.push("-iname", `*${filter.value}*`);
            }
          }

          // Handle hidden files
          if (!includeHidden) {
            findArgs.push("!", "-name", ".*");
          }

          // Execute the find command using proper argument passing (no shell injection risk)
          const result = yield* Effect.promise<{
            stdout: string;
            stderr: string;
            exitCode: number;
          }>(
            () =>
              new Promise((resolve, reject) => {
                const sanitizedEnv = createSanitizedEnv();
                const child = spawn("find", findArgs, {
                  cwd: searchPath,
                  stdio: ["ignore", "pipe", "pipe"],
                  env: sanitizedEnv,
                  timeout: 30000,
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

          if (result.exitCode !== 0) {
            // Continue to next search path if this one fails
            continue;
          }

          // Parse results
          const paths = result.stdout
            .split("\n")
            .filter((line) => line.trim())
            .map((path) => {
              const name = path.split("/").pop() || "";
              // Determine type by checking if it's a directory
              // We'll use a simple heuristic: if it doesn't have an extension and is likely a dir
              const isDir = !name.includes(".") || name.endsWith("/");
              return {
                path: path.trim(),
                name,
                type: isDir ? ("dir" as const) : ("file" as const),
              };
            });

          allResults.push(...paths);

          // If we found results and using smart search, we can stop early
          // This prevents searching too many locations when we already have good results
          if (useSmart && allResults.length >= Math.min(maxResults / 2, 10)) {
            break;
          }
        }

        return {
          success: true,
          result: allResults.slice(0, maxResults),
        };
      }),
  });
}
