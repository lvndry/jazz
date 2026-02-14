import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import glob from "fast-glob";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { Tool } from "@/core/interfaces/tool-registry";
import { defineTool } from "../base-tool";
import { buildKeyFromContext } from "../context-utils";
import { normalizeFilterPattern, readGitignorePatterns } from "./utils";

/**
 * List directory contents tool.
 */

export function createLsTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z.string().optional().describe("Directory path (defaults to cwd)"),
      showHidden: z.boolean().optional().describe("Include hidden files"),
      recursive: z.boolean().optional().describe("Recurse into subdirectories"),
      pattern: z.string().optional().describe("Name filter (substring or 're:<regex>')"),
      maxResults: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max results (default: 200, cap: 2000)"),
      maxDepth: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max depth for recursive listing (default: 10)"),
    })
    .strict();

  type LsParams = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, LsParams>({
    name: "ls",
    description:
      "List directory contents. Supports recursive traversal, name filtering, hidden files. Default 200 results, cap 2000.",
    tags: ["filesystem", "listing"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? { valid: true, value: params.data }
        : { valid: false, errors: params.error.issues.map((i) => i.message) };
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const shell = yield* FileSystemContextServiceTag;

        // Resolve the target directory
        let resolvedPath: string | null = null;
        let pathError: string | null = null;

        if (args.path) {
          const pathResult = yield* shell.resolvePath(buildKeyFromContext(context), args.path).pipe(
            Effect.catchAll((error: unknown) => {
              pathError = error instanceof Error ? error.message : String(error);
              return Effect.succeed(null);
            }),
          );

          if (pathResult === null) {
            return { success: false, result: null, error: pathError || "Failed to resolve path" };
          }
          resolvedPath = pathResult;
        } else {
          resolvedPath = yield* shell.getCwd(buildKeyFromContext(context));
        }

        // Validate path exists and is a directory
        const statResult = yield* fs.stat(resolvedPath).pipe(
          Effect.catchAll((error: unknown) =>
            Effect.succeed({
              _error: `Path not found: ${resolvedPath}. ${error instanceof Error ? error.message : String(error)}`,
            }),
          ),
        );

        if ("_error" in statResult) {
          return { success: false, result: null, error: statResult._error };
        }

        if (statResult.type !== "Directory") {
          return { success: false, result: null, error: `Not a directory: ${resolvedPath}` };
        }

        const includeHidden = args.showHidden === true;
        const recursive = args.recursive === true;
        const requestedMaxResults =
          typeof args.maxResults === "number" && args.maxResults > 0 ? args.maxResults : 200;
        const maxResults = Math.min(requestedMaxResults, 2000);
        const maxDepth = recursive ? (args.maxDepth ?? 10) : 1;
        const filter = normalizeFilterPattern(args.pattern);

        // Read .gitignore patterns for the target directory
        const ignorePatterns = includeHidden ? [] : yield* readGitignorePatterns(fs, resolvedPath);

        // Use fast-glob with both files and directories
        const globOptions: glob.Options = {
          cwd: resolvedPath,
          absolute: true,
          deep: maxDepth,
          dot: includeHidden,
          stats: false,
          suppressErrors: true,
          followSymbolicLinks: false,
          ignore: ignorePatterns,
          onlyFiles: false,
          markDirectories: true,
        };

        // Build glob pattern — we always want everything, filtering happens post-glob
        const entries = yield* Effect.tryPromise({
          try: () => glob("**", globOptions),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }).pipe(Effect.catchAll(() => Effect.succeed([] as string[])));

        const results: { path: string; name: string; type: "file" | "dir" }[] = [];

        for (const entryPath of entries) {
          if (results.length >= maxResults) break;

          const isDir = entryPath.endsWith("/");
          const cleanPath = isDir ? entryPath.slice(0, -1) : entryPath;
          const name = cleanPath.split("/").pop() || "";

          // Apply filter
          if (filter.type === "regex" && filter.regex) {
            if (!filter.regex.test(name)) continue;
          } else if (filter.type === "substring" && filter.value) {
            if (!name.includes(filter.value)) continue;
          }

          results.push({
            path: cleanPath,
            name,
            type: isDir ? "dir" : "file",
          });
        }

        return { success: true, result: results };
      }).pipe(
        Effect.catchAll((error: unknown) =>
          Effect.succeed({
            success: false,
            result: null,
            error: `ls failed: ${error instanceof Error ? error.message : String(error)}`,
          }),
        ),
      ),
  });
}
