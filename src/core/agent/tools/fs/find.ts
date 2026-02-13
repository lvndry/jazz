import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import glob from "fast-glob";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { Tool } from "@/core/interfaces/tool-registry";
import { createSanitizedEnv } from "@/core/utils/env-utils";
import { defineTool } from "../base-tool";
import { buildKeyFromContext } from "../context-utils";
import {
  checkExternalTool,
  normalizeFilterPattern,
  readGitignorePatterns,
  spawnCollect,
} from "./utils";

/**
 * Unified file and directory search tool.
 *
 * Picks the best backend automatically:
 * - **fast-glob** for basic name/type/depth searches (pure JS, no child process).
 * - **fd → system find** for advanced filters (size, mtime, minDepth, pathPattern,
 *   excludePaths) that fast-glob cannot handle natively.
 *
 * Features:
 * - Smart hierarchical search (cwd → parents → home) with parallel scanning.
 * - .gitignore-aware by default.
 * - Results sorted by most recently modified first.
 * - Glob patterns, regex, type filters, hidden files.
 * - Size/mtime/minDepth/pathPattern/excludePaths when needed.
 */

export function createFindTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z
        .string()
        .optional()
        .describe(
          "Start directory (defaults to smart search from cwd→parents→home). NEVER use '/'. Omit to use smart search.",
        ),
      name: z
        .string()
        .optional()
        .describe(
          "Filter by name: substring match, glob pattern (e.g. '*.ts', 'test_*', '*.{js,jsx}'), or regex with 're:' prefix (e.g. 're:test.*\\.ts$')",
        ),
      type: z
        .enum(["file", "dir", "all", "symlink"])
        .optional()
        .describe("Type filter (default: 'all')"),
      maxDepth: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Maximum depth to traverse (default: 25, use 0 for current dir only)"),
      minDepth: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Minimum depth (default: 0). Triggers fd/find backend."),
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
        .describe(
          "Use smart hierarchical search (cwd→parents→home). Keep enabled unless you provide a specific path.",
        ),
      // --- Advanced filters (trigger fd/find backend automatically) ---
      pathPattern: z
        .string()
        .optional()
        .describe("Full-path pattern to match (e.g. '**/test/**'). Triggers fd/find backend."),
      excludePaths: z
        .array(z.string())
        .optional()
        .describe("Paths to exclude (e.g. ['node_modules', '.git']). Triggers fd/find backend."),
      caseSensitive: z.boolean().optional().describe("Case-sensitive matching (default: false)"),
      size: z
        .string()
        .optional()
        .describe("File size filter (e.g. '+100M', '-1k'). Triggers fd/find backend."),
      mtime: z
        .string()
        .optional()
        .describe(
          "Modification time filter (e.g. '-7' for last 7 days, '+30' for older than 30 days). Triggers fd/find backend.",
        ),
    })
    .strict();

  type FindArgs = z.infer<typeof parameters>;

  // -------------------------------------------------------------------
  // Decide which backend to use
  // -------------------------------------------------------------------
  function needsExternalBackend(args: FindArgs): boolean {
    return !!(args.size || args.mtime || args.minDepth || args.pathPattern || args.excludePaths);
  }

  // ===================================================================
  // BACKEND 1: fast-glob (default for basic searches)
  // ===================================================================

  function searchWithGlob(
    args: FindArgs,
    searchPaths: string[],
    maxResults: number,
    maxDepth: number,
    fs: FileSystem.FileSystem,
  ): Effect.Effect<
    { path: string; name: string; type: "file" | "dir"; mtimeMs: number }[],
    Error,
    FileSystem.FileSystem
  > {
    return Effect.gen(function* () {
      const includeHidden = args.includeHidden === true;
      const typeFilter = args.type ?? "all";
      const useSmart = args.smart !== false && !args.path;

      // Build glob pattern
      let globPattern = "**";
      const filter = args.name ? normalizeFilterPattern(args.name) : null;

      if (filter && filter.type === "substring" && filter.value) {
        // Check if the name looks like a glob pattern
        const val = filter.value;
        if (val.includes("*") || val.includes("?") || val.includes("[") || val.includes("{")) {
          // Use as glob pattern directly
          globPattern = `**/${val}`;
        } else {
          const escaped = glob.escapePath(val);
          globPattern = `**/*${escaped}*`;
        }
      }

      function searchRoot(
        searchPath: string,
      ): Effect.Effect<
        { path: string; name: string; type: "file" | "dir"; mtimeMs: number }[],
        Error,
        FileSystem.FileSystem
      > {
        return Effect.gen(function* () {
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
            ...(args.caseSensitive !== undefined ? { caseSensitiveMatch: args.caseSensitive } : {}),
          };

          const entries = yield* Effect.tryPromise({
            try: () => glob(globPattern, globOptions),
            catch: (error) => (error instanceof Error ? error : new Error(String(error))),
          });

          const results: { path: string; name: string; type: "file" | "dir"; mtimeMs: number }[] =
            [];

          for (const entry of entries) {
            const entryObj = entry as unknown as {
              path: string;
              name: string;
              stats?: { isDirectory: () => boolean; mtimeMs: number };
            };
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

          results.sort((a, b) => b.mtimeMs - a.mtimeMs);
          return results;
        });
      }

      // Execute searches — parallel for multi-root
      let allResults: { path: string; name: string; type: "file" | "dir"; mtimeMs: number }[] = [];

      if (useSmart && searchPaths.length > 1) {
        const primaryResults = yield* searchRoot(searchPaths[0]!);
        allResults.push(...primaryResults);

        if (allResults.length < Math.min(maxResults / 2, 10)) {
          const remaining = searchPaths.slice(1);
          const parallelResults = yield* Effect.all(
            remaining.map((p) => searchRoot(p)),
            { concurrency: remaining.length },
          );
          for (const batch of parallelResults) {
            allResults.push(...batch);
          }
        }
      } else if (searchPaths.length > 0) {
        const results = yield* searchRoot(searchPaths[0]!);
        allResults.push(...results);
      }

      // De-duplicate and sort
      const seen = new Set<string>();
      allResults = allResults.filter((r) => {
        if (seen.has(r.path)) return false;
        seen.add(r.path);
        return true;
      });
      allResults.sort((a, b) => b.mtimeMs - a.mtimeMs);
      return allResults;
    });
  }

  // ===================================================================
  // BACKEND 2: fd (preferred) → system find (fallback)
  // ===================================================================

  function buildFdArgs(args: FindArgs, searchDir: string): string[] {
    const fdArgs: string[] = [];
    const maxDepth = typeof args.maxDepth === "number" ? args.maxDepth : 25;
    const typeFilter = args.type ?? "all";
    const caseSensitive = args.caseSensitive ?? false;

    // Type filter
    if (typeFilter === "file") fdArgs.push("--type", "f");
    else if (typeFilter === "dir") fdArgs.push("--type", "d");
    else if (typeFilter === "symlink") fdArgs.push("--type", "l");

    // Depth
    fdArgs.push("--max-depth", maxDepth.toString());
    if (args.minDepth && args.minDepth > 0) {
      fdArgs.push("--min-depth", args.minDepth.toString());
    }

    // Case
    if (caseSensitive) fdArgs.push("--case-sensitive");
    else fdArgs.push("--ignore-case");

    // Hidden
    if (args.includeHidden) fdArgs.push("--hidden");

    // Exclusions
    if (args.excludePaths) {
      for (const ex of args.excludePaths) {
        fdArgs.push("--exclude", ex);
      }
    }

    // Size
    if (args.size) fdArgs.push("--size", args.size);

    // Mtime
    if (args.mtime) {
      const trimmed = args.mtime.trim();
      if (trimmed.startsWith("-")) {
        fdArgs.push("--changed-within", `${trimmed.slice(1)}d`);
      } else if (trimmed.startsWith("+")) {
        fdArgs.push("--changed-before", `${trimmed.slice(1)}d`);
      }
    }

    // Name pattern
    if (args.name) {
      const filter = normalizeFilterPattern(args.name);
      if (filter.type === "regex" && filter.regex) {
        fdArgs.push(filter.regex.source);
      } else if (filter.value) {
        if (
          filter.value.includes("*") ||
          filter.value.includes("?") ||
          filter.value.includes("[")
        ) {
          fdArgs.push("--glob", filter.value);
        } else {
          fdArgs.push(filter.value);
        }
      }
    }

    // Path pattern
    if (args.pathPattern) {
      fdArgs.push("--full-path", args.pathPattern);
    }

    fdArgs.push(searchDir);
    return fdArgs;
  }

  function buildSystemFindArgs(args: FindArgs, searchDir: string): string[] {
    const findArgs: string[] = [searchDir];
    const maxDepth = typeof args.maxDepth === "number" ? args.maxDepth : 25;
    const typeFilter = args.type ?? "all";
    const caseSensitive = args.caseSensitive ?? false;

    if (args.minDepth && args.minDepth > 0) {
      findArgs.push("-mindepth", args.minDepth.toString());
    }
    findArgs.push("-maxdepth", maxDepth.toString());

    const expr: string[] = [];

    // Exclusions
    if (args.excludePaths && args.excludePaths.length > 0) {
      for (const ex of args.excludePaths) {
        expr.push("-path", ex, "-prune", "-o");
      }
    }

    if (args.pathPattern) expr.push("-path", args.pathPattern);

    // Type
    if (typeFilter === "dir") expr.push("-type", "d");
    else if (typeFilter === "file") expr.push("-type", "f");
    else if (typeFilter === "symlink") expr.push("-type", "l");

    // Name
    if (args.name) {
      const filter = normalizeFilterPattern(args.name);
      if (filter.type === "regex" && filter.regex) {
        expr.push("-regex", filter.regex.source);
      } else if (filter.value) {
        const pattern =
          filter.value.includes("*") || filter.value.includes("?") || filter.value.includes("[")
            ? filter.value
            : `*${filter.value}*`;
        expr.push(caseSensitive ? "-name" : "-iname", pattern);
      }
    }

    if (args.size) expr.push("-size", args.size);
    if (args.mtime) expr.push("-mtime", args.mtime);

    if (args.excludePaths && args.excludePaths.length > 0) {
      expr.push("-print");
    }

    if (expr.length > 0) findArgs.push(...expr);
    return findArgs;
  }

  function parseFdResults(
    stdout: string,
    typeFilter: string,
    maxResults: number,
  ): { path: string; name: string; type: "file" | "dir" | "symlink"; mtimeMs: number }[] {
    return stdout
      .split("\n")
      .filter((line) => line.trim())
      .slice(0, maxResults)
      .map((p) => {
        const trimmed = p.trim();
        const isDir = trimmed.endsWith("/");
        const cleanPath = isDir ? trimmed.slice(0, -1) : trimmed;
        const name = cleanPath.split("/").pop() || "";
        let type: "file" | "dir" | "symlink";
        if (typeFilter === "dir") type = "dir";
        else if (typeFilter === "symlink") type = "symlink";
        else if (typeFilter === "file") type = "file";
        else type = isDir ? "dir" : "file";
        return { path: cleanPath, name, type, mtimeMs: 0 };
      });
  }

  function parseFindResults(
    stdout: string,
    maxResults: number,
  ): Effect.Effect<
    { path: string; name: string; type: "file" | "dir" | "symlink"; mtimeMs: number }[],
    never,
    FileSystem.FileSystem
  > {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const lines = stdout
        .split("\n")
        .filter((line) => line.trim())
        .slice(0, maxResults);

      const results: {
        path: string;
        name: string;
        type: "file" | "dir" | "symlink";
        mtimeMs: number;
      }[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        const name = trimmed.split("/").pop() || "";
        const stat = yield* fs.stat(trimmed).pipe(Effect.catchAll(() => Effect.succeed(null)));
        const type: "file" | "dir" | "symlink" = stat
          ? stat.type === "Directory"
            ? "dir"
            : stat.type === "SymbolicLink"
              ? "symlink"
              : "file"
          : "file";
        results.push({ path: trimmed, name, type, mtimeMs: 0 });
      }
      return results;
    });
  }

  function searchWithExternal(
    args: FindArgs,
    searchDir: string,
    cwd: string,
    maxResults: number,
  ): Effect.Effect<
    {
      path: string;
      name: string;
      type: "file" | "dir" | "symlink";
      mtimeMs: number;
      backend: string;
    }[],
    Error,
    FileSystem.FileSystem
  > {
    return Effect.gen(function* () {
      const typeFilter = args.type ?? "all";
      const sanitizedEnv = createSanitizedEnv();
      const useFd = yield* Effect.promise(() => checkExternalTool("fd"));

      if (useFd) {
        const fdArgs = buildFdArgs(args, searchDir);
        const out = yield* spawnCollect("fd", fdArgs, {
          cwd,
          env: sanitizedEnv,
          timeout: 30_000,
        });

        if (out.exitCode === 0 || out.exitCode === 1) {
          return parseFdResults(out.stdout, typeFilter, maxResults).map((r) => ({
            ...r,
            backend: "fd",
          }));
        }
        // fd failed — fall through to system find
      }

      // System find
      const findArgs = buildSystemFindArgs(args, searchDir);
      const out = yield* spawnCollect("find", findArgs, {
        cwd,
        env: sanitizedEnv,
        timeout: 30_000,
      });

      if (out.exitCode !== 0 && out.exitCode !== 1) {
        return yield* Effect.fail(new Error(`find command failed: ${out.stderr}`));
      }

      const results = yield* parseFindResults(out.stdout, maxResults);
      return results.map((r) => ({ ...r, backend: "find" }));
    });
  }

  // ===================================================================
  // Tool definition
  // ===================================================================

  return defineTool<FileSystem.FileSystem | FileSystemContextService, FindArgs>({
    name: "find",
    description:
      "Find files and directories by name, glob pattern, or regex. Searches file/directory NAMES and PATHS — does NOT search file contents (use grep for that). Smart search by default: searches cwd → parent dirs → home. Supports glob patterns (e.g. '*.ts', '*.{js,jsx}'), regex ('re:test.*'), type filters, hidden files. Advanced filters (size, mtime, minDepth, pathPattern, excludePaths) automatically use fd/find backend. Results sorted by most recently modified. Default 200 results, hard cap 2000.",
    tags: ["filesystem", "search"],
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

        const requestedMaxResults =
          typeof args.maxResults === "number" && args.maxResults > 0 ? args.maxResults : 200;
        const maxResults = Math.min(requestedMaxResults, 2000);
        const maxDepth = typeof args.maxDepth === "number" ? args.maxDepth : 25;

        // Determine search roots
        const cwd = yield* shell.getCwd(buildKeyFromContext(context));

        if (needsExternalBackend(args)) {
          // ---------------------------------------------------------------
          // External backend path (fd / system find)
          // ---------------------------------------------------------------
          const searchDir = args.path
            ? yield* shell.resolvePath(buildKeyFromContext(context), args.path)
            : cwd;

          const results = yield* searchWithExternal(args, searchDir, cwd, maxResults);

          const finalResults = results.slice(0, maxResults).map(({ path, name, type }) => ({
            path,
            name,
            type,
          }));

          return {
            success: true,
            result: finalResults,
          };
        }

        // -----------------------------------------------------------------
        // fast-glob path (default for basic searches)
        // -----------------------------------------------------------------
        const searchPaths: string[] = [];
        const useSmart = args.smart !== false && !args.path;

        if (args.path) {
          const start = yield* shell.resolvePath(buildKeyFromContext(context), args.path);
          searchPaths.push(start);
        } else if (useSmart) {
          const home = process.env["HOME"] || "";

          if (cwd && cwd !== home) {
            searchPaths.push(cwd);
          }

          // Parents before home
          let currentPath = cwd;
          for (let i = 0; i < 3; i++) {
            const parent = currentPath.split("/").slice(0, -1).join("/");
            if (parent && parent !== currentPath && parent !== "/") {
              if (!searchPaths.includes(parent)) {
                searchPaths.push(parent);
              }
              currentPath = parent;
            } else {
              break;
            }
          }

          if (home && !searchPaths.includes(home)) {
            searchPaths.push(home);
          }
        } else {
          searchPaths.push(cwd);
        }

        const allResults = yield* searchWithGlob(args, searchPaths, maxResults, maxDepth, fs);

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
