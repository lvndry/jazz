import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { Tool } from "@/core/interfaces/tool-registry";
import { defineTool } from "../base-tool";
import { buildKeyFromContext } from "../context-utils";
import { normalizeFilterPattern } from "./utils";

/**
 * List directory contents tool
 */

export function createLsTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z
        .string()
        .optional()
        .describe("Directory path to list (defaults to current directory)"),
      showHidden: z.boolean().optional().describe("Include hidden files (dotfiles)"),
      recursive: z.boolean().optional().describe("Recurse into sub-directories"),
      pattern: z.string().optional().describe("Filter by substring or use 're:<regex>'"),
      maxResults: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of results to return"),
    })
    .strict();

  type LsParams = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, LsParams>({
    name: "ls",
    description:
      "List files and directories within a specified path. Supports recursive traversal, filtering by name patterns (substring or regex), showing hidden files, and limiting results. Returns file/directory names, paths, and types.",
    tags: ["filesystem", "listing"],
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
            return {
              success: false,
              result: null,
              error: pathError || "Failed to resolve path",
            };
          }

          resolvedPath = pathResult;
        } else {
          resolvedPath = yield* shell.getCwd(buildKeyFromContext(context));
        }

        const includeHidden = args.showHidden === true;
        const recursive = args.recursive === true;
        const maxResults =
          typeof args.maxResults === "number" && args.maxResults > 0 ? args.maxResults : 2000;
        const filter = normalizeFilterPattern(args.pattern);

        function matches(name: string): boolean {
          if (!filter.value && !filter.regex) return true;
          if (filter.type === "regex" && filter.regex) return filter.regex.test(name);
          return filter.value ? name.includes(filter.value) : true;
        }

        const results: { path: string; name: string; type: "file" | "dir" }[] = [];

        function walk(dir: string): Effect.Effect<void, Error, FileSystem.FileSystem> {
          return Effect.gen(function* () {
            // Handle permission errors gracefully
            const entries = yield* fs
              .readDirectory(dir)
              .pipe(Effect.catchAll(() => Effect.succeed([])));

            for (const name of entries) {
              if (!includeHidden && name.startsWith(".")) continue;
              const full = `${dir}/${name}`;

              // Handle broken symbolic links gracefully
              const stat = yield* fs.stat(full).pipe(Effect.catchAll(() => Effect.succeed(null)));

              if (!stat) {
                // Skip broken symbolic links or inaccessible files
                continue;
              }

              const type = stat.type === "Directory" ? "dir" : "file";
              if (matches(name)) {
                results.push({ path: full, name, type });
                if (results.length >= maxResults) return;
              }
              if (recursive && stat.type === "Directory") {
                yield* walk(full);
                if (results.length >= maxResults) return;
              }
            }
          });
        }

        // Check if the path exists and is a directory
        let statError: string | null = null;
        const statResult = yield* fs.stat(resolvedPath).pipe(
          Effect.catchAll((error: unknown) => {
            statError = `Path not found: ${resolvedPath}. ${error instanceof Error ? error.message : String(error)}`;
            return Effect.succeed(null);
          }),
        );

        // If stat failed, return the error
        if (statResult === null) {
          return {
            success: false,
            result: null,
            error: statError || `Path not found: ${resolvedPath}`,
          };
        }

        // Check if it's a directory
        if (statResult.type !== "Directory") {
          return { success: false, result: null, error: `Not a directory: ${resolvedPath}` };
        }

        // Walk the directory - errors are handled inside walk() for individual entries
        yield* walk(resolvedPath).pipe(Effect.catchAll(() => Effect.void));

        return { success: true, result: results };
      }).pipe(
        // Wrap the entire handler in error handling to catch any unhandled errors
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
