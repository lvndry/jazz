import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { Tool } from "@/core/interfaces/tool-registry";
import { createSanitizedEnv } from "@/core/utils/env-utils";
import { defineTool } from "../base-tool";
import { buildKeyFromContext } from "../context-utils";
import { checkExternalTool, spawnCollect } from "./utils";

/**
 * Find files by path pattern tool.
 *
 * Optimisations:
 * - **`fd` first, `find` fallback**: Uses `fd` (fd-find) when available — it is
 *   multi-threaded, respects .gitignore by default, and considerably faster than
 *   GNU/BSD `find`. Falls back silently to system `find` if `fd` is not installed.
 * - **Proper type detection**: Uses `stat` via the `-printf` flag (GNU) or
 *   just parses `fd --type` output (fd already knows the type) instead of the
 *   broken `!name.includes(".")` heuristic.
 * - **Raised result cap**: Default 200 (up from 50), hard cap 2000.
 */

export function createFindPathTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      name: z
        .string()
        .min(1)
        .optional()
        .describe("Name or glob pattern (e.g., 'test', '*.js', 'test*', '*.{js,ts}')"),
      pathPattern: z
        .string()
        .optional()
        .describe("Path pattern to match (e.g., './node_modules', '**/test/**')"),
      excludePaths: z
        .array(z.string())
        .optional()
        .describe("Paths to exclude from search (e.g., ['./node_modules', './.git'])"),
      caseSensitive: z
        .boolean()
        .optional()
        .describe("Use case-sensitive matching (default: false)"),
      regex: z
        .string()
        .optional()
        .describe("Regex pattern for name matching (overrides name if provided)"),
      maxDepth: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum search depth (default: 5)"),
      minDepth: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Minimum search depth (default: 0)"),
      type: z
        .enum(["directory", "file", "both", "symlink"])
        .optional()
        .describe("Type of item to search for (directory, file, both, or symlink)"),
      size: z
        .string()
        .optional()
        .describe(
          "File size filter (e.g., '+100M' for >100MB, '-1k' for <1KB, '500' for exactly 500 bytes)",
        ),
      mtime: z
        .string()
        .optional()
        .describe(
          "Modification time filter (e.g., '-7' for last 7 days, '+30' for older than 30 days). With fd, use duration format like '7d' or '30d'.",
        ),
      searchPath: z
        .string()
        .optional()
        .describe(
          "Directory to start search from (defaults to current directory). NEVER use '/' as it's too broad and slow.",
        ),
      maxResults: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum results to return (default: 200, hard cap: 2000)"),
      includeHidden: z.boolean().optional().describe("Include hidden files and directories"),
    })
    .strict()
    .refine((data) => data.name || data.pathPattern || data.regex, {
      message: "At least one of 'name', 'pathPattern', or 'regex' must be provided",
    });

  type FindPathParams = z.infer<typeof parameters>;

  // -------------------------------------------------------------------
  // fd builder
  // -------------------------------------------------------------------
  function buildFdArgs(args: FindPathParams, searchDir: string): string[] {
    const fdArgs: string[] = [];
    const maxDepth = args.maxDepth ?? 5;
    const searchType = args.type ?? "both";
    const caseSensitive = args.caseSensitive ?? false;

    // Type filter
    if (searchType === "file") fdArgs.push("--type", "f");
    else if (searchType === "directory") fdArgs.push("--type", "d");
    else if (searchType === "symlink") fdArgs.push("--type", "l");

    // Depth
    fdArgs.push("--max-depth", maxDepth.toString());
    if (args.minDepth && args.minDepth > 0) {
      fdArgs.push("--min-depth", args.minDepth.toString());
    }

    // Case sensitivity — fd is smart-case by default
    if (caseSensitive) fdArgs.push("--case-sensitive");
    else fdArgs.push("--ignore-case");

    // Hidden files
    if (args.includeHidden) fdArgs.push("--hidden");

    // Exclusions
    if (args.excludePaths) {
      for (const ex of args.excludePaths) {
        fdArgs.push("--exclude", ex);
      }
    }

    // Size filter (fd uses --size with same syntax: +100M, -1k, etc.)
    if (args.size) fdArgs.push("--size", args.size);

    // Modification time (fd uses --changed-within / --changed-before)
    if (args.mtime) {
      const trimmed = args.mtime.trim();
      if (trimmed.startsWith("-")) {
        // "-7" means within last 7 days → --changed-within 7d
        fdArgs.push("--changed-within", `${trimmed.slice(1)}d`);
      } else if (trimmed.startsWith("+")) {
        // "+30" means older than 30 days → --changed-before 30d
        fdArgs.push("--changed-before", `${trimmed.slice(1)}d`);
      }
    }

    // Search pattern
    if (args.regex) {
      fdArgs.push(args.regex);
    } else if (args.name) {
      // fd uses regex by default — convert glob to regex-friendly or use glob flag
      if (args.name.includes("*") || args.name.includes("?") || args.name.includes("[")) {
        fdArgs.push("--glob", args.name);
      } else {
        // Partial match (substring)
        fdArgs.push(args.name);
      }
    }

    // Path pattern as additional glob filter
    if (args.pathPattern) {
      fdArgs.push("--full-path", args.pathPattern);
    }

    // Search directory
    fdArgs.push(searchDir);

    return fdArgs;
  }

  // -------------------------------------------------------------------
  // system find builder (unchanged logic, just extracted)
  // -------------------------------------------------------------------
  function buildFindArgs(args: FindPathParams, searchDir: string): string[] {
    const findArgs: string[] = [searchDir];
    const maxDepth = args.maxDepth ?? 5;
    const searchType = args.type ?? "both";
    const caseSensitive = args.caseSensitive ?? false;

    if (args.minDepth && args.minDepth > 0) {
      findArgs.push("-mindepth", args.minDepth.toString());
    }
    findArgs.push("-maxdepth", maxDepth.toString());

    const expressionParts: string[] = [];

    // Exclusions
    if (args.excludePaths && args.excludePaths.length > 0) {
      for (const excludePath of args.excludePaths) {
        expressionParts.push("-path", excludePath, "-prune", "-o");
      }
    }

    if (args.pathPattern) expressionParts.push("-path", args.pathPattern);

    // Type
    if (searchType === "directory") expressionParts.push("-type", "d");
    else if (searchType === "file") expressionParts.push("-type", "f");
    else if (searchType === "symlink") expressionParts.push("-type", "l");

    // Name / regex
    if (args.regex) {
      expressionParts.push("-regex", args.regex);
    } else if (args.name) {
      const pattern =
        args.name.includes("*") || args.name.includes("?") || args.name.includes("[")
          ? args.name
          : `*${args.name}*`;
      expressionParts.push(caseSensitive ? "-name" : "-iname", pattern);
    }

    if (args.size) expressionParts.push("-size", args.size);
    if (args.mtime) expressionParts.push("-mtime", args.mtime);

    // Use -print with type info: prints "path\0type" using -printf when available
    // On macOS (BSD find), -printf is not supported so we fall back to plain -print
    if (args.excludePaths && args.excludePaths.length > 0) {
      expressionParts.push("-print");
    }

    if (expressionParts.length > 0) findArgs.push(...expressionParts);
    return findArgs;
  }

  // -------------------------------------------------------------------
  // Parse results for fd output (one path per line, type already filtered)
  // -------------------------------------------------------------------
  function parseFdResults(
    stdout: string,
    searchType: string,
    maxResults: number,
  ): { path: string; name: string; type: string }[] {
    return stdout
      .split("\n")
      .filter((line) => line.trim())
      .slice(0, maxResults)
      .map((p) => {
        const trimmed = p.trim();
        const name = trimmed.split("/").pop() || "";
        // fd already filters by type; if "both" we detect by trailing /
        const isDir = trimmed.endsWith("/");
        let type: string;
        if (searchType === "directory") type = "dir";
        else if (searchType === "file") type = "file";
        else if (searchType === "symlink") type = "symlink";
        else type = isDir ? "dir" : "file";
        return { path: trimmed.replace(/\/$/, ""), name, type };
      });
  }

  // -------------------------------------------------------------------
  // Parse results for system find output — use stat for proper type detection
  // -------------------------------------------------------------------
  function parseFindResults(
    stdout: string,
    maxResults: number,
  ): Effect.Effect<{ path: string; name: string; type: string }[], never, FileSystem.FileSystem> {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const lines = stdout
        .split("\n")
        .filter((line) => line.trim())
        .slice(0, maxResults);

      const results: { path: string; name: string; type: string }[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        const name = trimmed.split("/").pop() || "";
        // Use actual stat for proper type detection instead of heuristic
        const stat = yield* fs.stat(trimmed).pipe(Effect.catchAll(() => Effect.succeed(null)));
        const type = stat
          ? stat.type === "Directory"
            ? "dir"
            : stat.type === "SymbolicLink"
              ? "symlink"
              : "file"
          : "file";
        results.push({ path: trimmed, name, type });
      }
      return results;
    });
  }

  return defineTool<FileSystem.FileSystem | FileSystemContextService, FindPathParams>({
    name: "find_path",
    description:
      "Advanced file search using fd (fast, multi-threaded, .gitignore-aware) with automatic fallback to system find. Searches from current directory by default (or specific directory via searchPath). NEVER use searchPath: '/' as it's too broad and slow—always search from current directory or a specific subdirectory. Supports glob patterns, path matching, exclusions, regex, size/time filters, and depth control (default maxDepth: 5). Defaults to 200 results (hard cap 2000).",
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
        const shell = yield* FileSystemContextServiceTag;

        const currentDir = yield* shell.getCwd(buildKeyFromContext(context));
        const searchDir = args.searchPath
          ? yield* shell.resolvePath(buildKeyFromContext(context), args.searchPath)
          : currentDir;

        const searchType = args.type ?? "both";
        const requestedMaxResults =
          typeof args.maxResults === "number" && args.maxResults > 0 ? args.maxResults : 200;
        const maxResults = Math.min(requestedMaxResults, 2000);
        const sanitizedEnv = createSanitizedEnv();

        // Try fd first, fall back to system find
        const useFd = yield* Effect.promise(() => checkExternalTool("fd"));

        let results: { path: string; name: string; type: string }[];

        if (useFd) {
          const fdArgs = buildFdArgs(args, searchDir);
          const out = yield* spawnCollect("fd", fdArgs, {
            cwd: currentDir,
            env: sanitizedEnv,
            timeout: 30_000,
          });

          if (out.exitCode !== 0 && out.exitCode !== 1) {
            // fd failed — fall back to system find
            const findArgs = buildFindArgs(args, searchDir);
            const findOut = yield* spawnCollect("find", findArgs, {
              cwd: currentDir,
              env: sanitizedEnv,
              timeout: 30_000,
            });

            if (findOut.exitCode !== 0 && findOut.exitCode !== 1) {
              return {
                success: false,
                result: null,
                error: `find command failed: ${findOut.stderr}`,
              };
            }
            results = yield* parseFindResults(findOut.stdout, maxResults);
          } else {
            results = parseFdResults(out.stdout, searchType, maxResults);
          }
        } else {
          // No fd available — use system find
          const findArgs = buildFindArgs(args, searchDir);
          const out = yield* spawnCollect("find", findArgs, {
            cwd: currentDir,
            env: sanitizedEnv,
            timeout: 30_000,
          });

          if (out.exitCode !== 0 && out.exitCode !== 1) {
            return {
              success: false,
              result: null,
              error: `find command failed: ${out.stderr}`,
            };
          }
          results = yield* parseFindResults(out.stdout, maxResults);
        }

        return {
          success: true,
          result: {
            searchTerm: args.name,
            currentDirectory: currentDir,
            searchDirectory: searchDir,
            maxDepth: args.maxDepth ?? 5,
            type: searchType,
            backend: useFd ? "fd" : "find",
            results: results.slice(0, maxResults),
            totalFound: results.length,
            message:
              results.length === 0
                ? `No ${searchType === "both" ? "items" : searchType + "s"} found matching "${args.name ?? args.regex ?? args.pathPattern}"`
                : `Found ${results.length} ${searchType === "both" ? "items" : searchType + "s"} matching "${args.name ?? args.regex ?? args.pathPattern}"`,
          },
        };
      }),
  });
}
