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
 * Search file contents with patterns tool.
 *
 * Uses ripgrep (`rg`) when available — multi-threaded, .gitignore-aware.
 * Falls back silently to system `grep` if ripgrep is not installed.
 *
 * Optimisations over previous implementation:
 * - Uses the shared `checkExternalTool` cache (no more separate module-level var).
 * - Uses `spawnCollect` helper to reduce duplication and ensure consistent error
 *   handling / timeout behaviour across all child-process tools.
 * - On ripgrep failure (exit code > 1), automatically retries with system grep
 *   so the user never sees a "rg not found" error even if PATH is misconfigured.
 */

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
        .describe("Exclude files matching this pattern (e.g., '*.min.js', '*.log')."),
      excludeDir: z
        .string()
        .optional()
        .describe("Exclude directories matching this pattern (e.g., 'node_modules', '.git')."),
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

  // -------------------------------------------------------------------
  // Build argument arrays for ripgrep and system grep
  // -------------------------------------------------------------------

  function buildRipgrepArgs(
    args: GrepArgs,
    searchPath: string,
    isFile: boolean,
    isDirectory: boolean,
    recursive: boolean,
    maxResults: number,
    outputMode: string,
  ): string[] {
    const cmdArgs: string[] = [];

    if (!recursive || isFile) {
      if (isDirectory && !recursive) {
        cmdArgs.push("--max-depth", "1");
      }
    }

    if (args.ignoreCase) cmdArgs.push("-i");

    if (outputMode === "files") cmdArgs.push("-l");
    else if (outputMode === "count") cmdArgs.push("-c");
    else cmdArgs.push("-n");

    if (
      outputMode === "content" &&
      typeof args.contextLines === "number" &&
      args.contextLines > 0
    ) {
      cmdArgs.push("-C", args.contextLines.toString());
    }

    if (args.filePattern) cmdArgs.push("-g", args.filePattern);
    if (args.exclude) cmdArgs.push("-g", `!${args.exclude}`);
    if (args.excludeDir) cmdArgs.push("-g", `!${args.excludeDir}/`);

    cmdArgs.push("-m", maxResults.toString());

    let searchPattern: string;
    if (args.regex === true || args.pattern.startsWith("re:")) {
      searchPattern = args.regex === true ? args.pattern : args.pattern.slice(3) || "";
    } else {
      searchPattern = args.pattern;
      cmdArgs.push("--fixed-strings");
    }

    cmdArgs.push(searchPattern, searchPath);
    return cmdArgs;
  }

  function buildSystemGrepArgs(
    args: GrepArgs,
    searchPath: string,
    isDirectory: boolean,
    recursive: boolean,
    maxResults: number,
    outputMode: string,
  ): string[] {
    const cmdArgs: string[] = [];

    if (recursive && isDirectory) cmdArgs.push("-r");
    if (args.ignoreCase) cmdArgs.push("-i");

    if (outputMode === "files") cmdArgs.push("-l");
    else if (outputMode === "count") cmdArgs.push("-c");
    else cmdArgs.push("-n");

    if (
      outputMode === "content" &&
      typeof args.contextLines === "number" &&
      args.contextLines > 0
    ) {
      cmdArgs.push("-C", args.contextLines.toString());
    }

    if (args.filePattern) cmdArgs.push("--include", args.filePattern);
    if (args.exclude) cmdArgs.push("--exclude", args.exclude);
    if (args.excludeDir) cmdArgs.push("--exclude-dir", args.excludeDir);

    cmdArgs.push("-m", maxResults.toString());

    let searchPattern: string;
    if (args.regex === true || args.pattern.startsWith("re:")) {
      searchPattern = args.regex === true ? args.pattern : args.pattern.slice(3) || "";
      cmdArgs.push("-E");
    } else {
      searchPattern = args.pattern;
      cmdArgs.push("-F");
    }

    cmdArgs.push(searchPattern, searchPath);
    return cmdArgs;
  }

  // -------------------------------------------------------------------
  // Output parsers
  // -------------------------------------------------------------------

  function parseFilesOutput(stdout: string, maxResults: number) {
    return stdout
      .split("\n")
      .filter((line) => line.trim())
      .slice(0, maxResults);
  }

  function parseCountOutput(stdout: string, maxResults: number) {
    const counts: Array<{ file: string; count: number }> = [];
    const lines = stdout.split("\n").filter((line) => line.trim());
    for (const line of lines) {
      const lastColon = line.lastIndexOf(":");
      if (lastColon > 0) {
        const file = line.slice(0, lastColon);
        const count = parseInt(line.slice(lastColon + 1), 10);
        if (!isNaN(count) && count > 0) {
          counts.push({ file, count });
        }
      }
    }
    return counts.slice(0, maxResults);
  }

  function parseContentOutput(stdout: string, maxResults: number) {
    const lines = stdout.split("\n").filter((line) => line.trim());
    const matches: Array<{ file: string; line: number; text: string }> = [];
    const seenMatches = new Set<string>();

    for (const line of lines) {
      if (line === "--") continue;
      const parts = line.split(":");
      if (parts.length >= 3 && parts[0] && parts[1]) {
        const file = parts[0];
        const lineNum = parseInt(parts[1], 10);
        const text = parts.slice(2).join(":");
        const key = `${file}:${lineNum}`;
        if (!seenMatches.has(key)) {
          seenMatches.add(key);
          matches.push({ file, line: lineNum, text });
        }
      }
    }
    return matches.slice(0, maxResults);
  }

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GrepArgs>({
    name: "grep",
    description:
      "Search for text patterns within file contents using ripgrep (rg) when available, with automatic fallback to system grep. Multi-threaded (with rg), respects .gitignore, and supports literal strings and regex patterns. Use to find specific code, text, or patterns across files. Returns matching lines with file paths and line numbers by default. Use outputMode 'files' for file paths only (minimal tokens) or 'count' for match counts per file. Defaults to 200 results (hard cap 2000). **Tip: Start with narrow paths or filePattern, then read specific files if needed.**",
    tags: ["search", "text"],
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
        const start = args.path
          ? yield* shell.resolvePath(buildKeyFromContext(context), args.path)
          : yield* shell.getCwd(buildKeyFromContext(context));
        const recursive = args.recursive !== false;
        const requestedMaxResults =
          typeof args.maxResults === "number" && args.maxResults > 0 ? args.maxResults : 200;
        const maxResults = Math.min(requestedMaxResults, 2000);
        const outputMode = args.outputMode ?? "content";

        // Check path exists
        const stat = yield* fs.stat(start).pipe(Effect.catchAll(() => Effect.succeed(null)));
        if (stat === null) {
          return yield* Effect.fail(new Error(`Path does not exist: ${start}`));
        }

        const isFile = stat.type === "File";
        const isDirectory = stat.type === "Directory";
        let workingDir: string;
        let searchPath: string;

        if (isFile) {
          const pathModule = yield* Effect.promise(() => import("path"));
          workingDir = pathModule.dirname(start);
          searchPath = start;
        } else {
          workingDir = start;
          searchPath = start;
        }

        const sanitizedEnv = createSanitizedEnv();

        // Try ripgrep first, fallback to grep
        const useRipgrep = yield* Effect.promise(() => checkExternalTool("rg"));

        let result: { stdout: string; stderr: string; exitCode: number };

        if (useRipgrep) {
          const rgArgs = buildRipgrepArgs(
            args,
            searchPath,
            isFile,
            isDirectory,
            recursive,
            maxResults,
            outputMode,
          );
          result = yield* spawnCollect("rg", rgArgs, {
            cwd: workingDir,
            env: sanitizedEnv,
            timeout: 30_000,
          });

          // If ripgrep failed unexpectedly (exit > 1), retry with system grep
          if (result.exitCode > 1) {
            const grepArgs = buildSystemGrepArgs(
              args,
              searchPath,
              isDirectory,
              recursive,
              maxResults,
              outputMode,
            );
            result = yield* spawnCollect("grep", grepArgs, {
              cwd: workingDir,
              env: sanitizedEnv,
              timeout: 30_000,
            });
          }
        } else {
          const grepArgs = buildSystemGrepArgs(
            args,
            searchPath,
            isDirectory,
            recursive,
            maxResults,
            outputMode,
          );
          result = yield* spawnCollect("grep", grepArgs, {
            cwd: workingDir,
            env: sanitizedEnv,
            timeout: 30_000,
          });
        }

        // Both rg and grep return exit code 1 when no matches are found
        if (result.exitCode !== 0 && result.exitCode !== 1) {
          return {
            success: false,
            result: null,
            error: `grep command failed: ${result.stderr}`,
          };
        }

        // Handle output modes
        if (outputMode === "files") {
          const files = parseFilesOutput(result.stdout, maxResults);
          return {
            success: true,
            result: {
              pattern: args.pattern,
              searchPath: start,
              outputMode,
              backend: useRipgrep ? "ripgrep" : "grep",
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
          const counts = parseCountOutput(result.stdout, maxResults);
          return {
            success: true,
            result: {
              pattern: args.pattern,
              searchPath: start,
              outputMode,
              backend: useRipgrep ? "ripgrep" : "grep",
              counts,
              totalFound: counts.length,
              message:
                counts.length === 0
                  ? `No matches found for pattern "${args.pattern}"`
                  : `Found matches in ${counts.length} files for pattern "${args.pattern}"`,
            },
          };
        }

        // Content mode (default)
        const matches = parseContentOutput(result.stdout, maxResults);
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
            backend: useRipgrep ? "ripgrep" : "grep",
            matches,
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
