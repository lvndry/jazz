import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import glob from "fast-glob";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { Tool } from "@/core/interfaces/tool-registry";
import { defineTool, makeZodValidator } from "../base-tool";
import { buildKeyFromContext } from "../context-utils";
import { normalizeFilterPattern, readGitignorePatterns } from "./utils";

/**
 * List directory contents tool.
 */

export function createLsTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z
        .string()
        .optional()
        .describe(
          "Directory to list. Absolute or relative to the session working directory. Defaults to the working directory.",
        ),
      showHidden: z
        .boolean()
        .optional()
        .describe("Include hidden files and directories (names starting with '.')."),
      recursive: z.boolean().optional().describe("Also list files in subdirectories."),
      pattern: z
        .string()
        .optional()
        .describe(
          "Filter entries by name. A plain string matches as a substring. Prefix with re: for a regex. This is not a glob — '*.ts' looks for those exact characters. Use find with name for globs.",
        ),
      maxResults: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of entries to return. Default 200, hard cap 2000."),
      maxDepth: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("How many directory levels to descend when recursive is true. Default 10."),
    })
    .strict();

  type LsParams = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, LsParams>({
    name: "ls",
    description:
      "List the contents of one directory. Defaults: this directory only, hidden files excluded, 200 results. " +
      "Use this to see what is in a folder. Do not use this to locate files by glob (find, also available as glob), to search file contents (grep), or to recurse the whole repository (find). " +
      "pattern is a substring or a re:<regex> — not a glob. '*.ts' matches the literal characters *.ts. Use find with name for globs. " +
      ".gitignore and node_modules are skipped unless showHidden is true.",
    tags: ["filesystem", "listing"],
    parameters,
    validate: makeZodValidator(parameters),
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
        if (filter.error) {
          return { success: false, result: null, error: filter.error };
        }

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
