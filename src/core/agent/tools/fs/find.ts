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
 * Find files and directories tool (uses fast-glob for speed)
 */

export function createFindTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z.string().optional().describe("Start directory (defaults to smart search from cwd→parent→home). NEVER use '/' as it's too broad and slow. Omit this parameter to use smart search."),
      name: z.string().optional().describe("Filter by name (substring or 're:<regex>')"),
      type: z.enum(["file", "dir", "all"]).optional().describe("Type filter"),
      maxDepth: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Maximum depth to traverse (0=current dir)"),
      maxResults: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum results to return (default: 200, hard cap: 2000)"),
      includeHidden: z.boolean().optional().describe("Include dotfiles and dot-directories"),
      smart: z
        .boolean()
        .default(true)
        .describe("Use smart hierarchical search (cwd→parent→home). Keep enabled unless you have a specific directory path."),
    })
    .strict();

  type FindArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, FindArgs>({
    name: "find",
    description:
      "Advanced file and directory search with smart hierarchical search strategy. By default (when path is omitted), searches in this order: (1) current directory, (2) parent directories (up to 3 levels), (3) home directory. NEVER specify path: '/' as it's too broad and slow—always omit the path parameter to use smart search, or provide a specific directory. Supports deep traversal (default 25 levels), regex patterns, type filters, and hidden files. Results are sorted by most recently modified first. Defaults to 200 results (hard cap 2000). Use for comprehensive searches when find_path doesn't locate what you need.",
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
        const fs = yield* FileSystem.FileSystem;
        const shell = yield* FileSystemContextServiceTag;

        const includeHidden = args.includeHidden === true;
        const requestedMaxResults =
          typeof args.maxResults === "number" && args.maxResults > 0 ? args.maxResults : 200;
        const maxResults = Math.min(requestedMaxResults, 2000);
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

        const allResults: { path: string; name: string; type: "file" | "dir"; mtimeMs?: number }[] = [];

        // Build the glob pattern based on name filter
        let globPattern = "**";
        const filter = args.name ? normalizeFilterPattern(args.name) : null;

        if (filter && filter.type === "substring" && filter.value) {
          // Escape glob metacharacters in user input before embedding in glob pattern
          const escaped = glob.escapePath(filter.value);
          globPattern = `**/*${escaped}*`;
        }
        // For regex filters, we'll filter after glob returns results

        // Search each path in order using fast-glob
        for (const searchPath of searchPaths) {
          if (allResults.length >= maxResults) break;

          const ignorePatterns = includeHidden ? [] : yield* readGitignorePatterns(fs, searchPath);

          const globOptions: glob.Options = {
            cwd: searchPath,
            absolute: true,
            deep: maxDepth === 0 ? 1 : maxDepth,
            dot: includeHidden,
            stats: true,
            suppressErrors: true,
            followSymbolicLinks: false,
            ignore: ignorePatterns,
            onlyFiles: typeFilter === "file",
            onlyDirectories: typeFilter === "dir",
            markDirectories: true,
          };

          const entries = yield* Effect.promise(() =>
            glob(globPattern, globOptions),
          );

          // Process entries
          const results: { path: string; name: string; type: "file" | "dir"; mtimeMs: number }[] = [];

          for (const entry of entries) {
            // fast-glob with stats returns Entry objects
            const entryObj = entry as unknown as { path: string; name: string; stats?: { isDirectory: () => boolean; mtimeMs: number } };
            const entryPath = entryObj.path;
            const entryName = entryObj.name || entryPath.split("/").pop() || "";
            const stats = entryObj.stats;
            const isDir = stats ? stats.isDirectory() : entryPath.endsWith("/");
            const mtimeMs = stats?.mtimeMs ?? 0;

            // Apply regex filter if needed
            if (filter && filter.type === "regex" && filter.regex) {
              if (!filter.regex.test(entryName)) continue;
            }

            results.push({
              path: entryPath,
              name: entryName,
              type: isDir ? "dir" : "file",
              mtimeMs,
            });
          }

          // Sort by modification time (most recent first)
          results.sort((a, b) => b.mtimeMs - a.mtimeMs);

          allResults.push(...results);

          // If we found results and using smart search, we can stop early
          // This prevents searching too many locations when we already have good results
          if (useSmart && allResults.length >= Math.min(maxResults / 2, 10)) {
            break;
          }
        }

        // Sort all results by mtime (most recent first) and trim
        allResults.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));

        // Strip mtimeMs from output
        const finalResults = allResults.slice(0, maxResults).map(({ path, name, type }) => ({
          path,
          name,
          type,
        }));

        return {
          success: true,
          result: finalResults,
        };
      }),
  });
}
