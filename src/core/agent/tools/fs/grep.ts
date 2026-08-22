import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { Tool } from "@/core/interfaces/tool-registry";
import { createSanitizedEnv } from "@/core/utils/env";
import { defineTool, makeZodValidator } from "../base-tool";
import { DEFAULT_SPAWN_OUTPUT_CAP_BYTES, type CollectedProcessOutput } from "../capped-output";
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

function resolveGrepPattern(
  pattern: string,
  regexFlag: boolean | undefined,
): { pattern: string; isRegex: boolean } {
  if (pattern.startsWith("re:")) {
    return { pattern: pattern.slice(3), isRegex: true };
  }
  return { pattern, isRegex: regexFlag === true };
}

export function createGrepTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      pattern: z
        .string()
        .min(1)
        .describe(
          "Literal text by default. For regex, EITHER prefix re: OR set regex:true — never both. Example literal: TODO. Example regex: re:function\\s+\\w+.",
        ),
      path: z
        .string()
        .optional()
        .describe(
          "File or directory to search. Default: session cwd. Prefer a narrow directory. Never /.",
        ),
      recursive: z
        .boolean()
        .optional()
        .describe("Recurse into directories. Default true. false = this directory only."),
      regex: z
        .boolean()
        .optional()
        .describe("If true, treat pattern as a regex. Prefer the re: prefix instead of this flag."),
      ignoreCase: z.boolean().optional().describe("Case-insensitive match"),
      maxResults: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max matches (default: 200, cap: 2000)"),
      filePattern: z.string().optional().describe("File glob filter (e.g. '*.js', '*.ts')"),
      exclude: z.string().optional().describe("Exclude files matching pattern"),
      excludeDir: z.string().optional().describe("Exclude directories matching pattern"),
      contextLines: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Context lines above/below each match"),
      outputMode: z
        .enum(["content", "files", "count"])
        .optional()
        .describe("'content' (default), 'files', or 'count'"),
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

    // Always include filename in output (rg omits it for single-file searches)
    cmdArgs.push("--with-filename");

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

    const resolved = resolveGrepPattern(args.pattern, args.regex);
    const searchPattern = resolved.pattern;
    if (!resolved.isRegex) {
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

    // Always include filename in output (grep omits it for single-file searches)
    cmdArgs.push("-H");

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

    const resolved = resolveGrepPattern(args.pattern, args.regex);
    const searchPattern = resolved.pattern;
    if (resolved.isRegex) {
      cmdArgs.push("-E");
    } else {
      cmdArgs.push("-F");
    }

    cmdArgs.push(searchPattern, searchPath);
    return cmdArgs;
  }

  // -------------------------------------------------------------------
  // Output parsers
  // -------------------------------------------------------------------

  function withGrepTruncationNote(message: string, truncated: boolean): string {
    if (!truncated) {
      return message;
    }
    return `${message} Output truncated at ${DEFAULT_SPAWN_OUTPUT_CAP_BYTES} bytes; narrow the path or pattern.`;
  }

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

  interface ContextLine {
    line: number;
    text: string;
  }

  interface ContentMatch {
    file: string;
    line: number;
    text: string;
    contextBefore?: ContextLine[];
    contextAfter?: ContextLine[];
  }

  interface ParsedContentLine {
    file: string;
    line: number;
    text: string;
    kind: "match" | "context";
  }

  function parseSearchOutputLine(rawLine: string): ParsedContentLine | null {
    // Both rg and grep use:
    // - "file:line:text" for a match
    // - "file-line-text" for context lines when -C is enabled
    const parsed = rawLine.match(/^(.*)([:-])(\d+)\2(.*)$/);
    if (!parsed) return null;
    const file = parsed[1] ?? "";
    const delimiter = parsed[2];
    const lineNum = parseInt(parsed[3] ?? "", 10);
    const text = parsed[4] ?? "";

    if (!file || Number.isNaN(lineNum)) return null;
    return {
      file,
      line: lineNum,
      text,
      kind: delimiter === ":" ? "match" : "context",
    };
  }

  function mergeContextLines(
    existing: ContextLine[] = [],
    incoming: ContextLine[] = [],
  ): ContextLine[] {
    const merged = [...existing];
    const seen = new Set(existing.map((c) => `${c.line}:${c.text}`));
    for (const line of incoming) {
      const key = `${line.line}:${line.text}`;
      if (!seen.has(key)) {
        merged.push(line);
        seen.add(key);
      }
    }
    return merged;
  }

  function parseContentOutput(
    stdout: string,
    maxResults: number,
    includeContext: boolean,
  ): ContentMatch[] {
    const lines = stdout.split("\n").filter((line) => line.trim());
    const blocks: string[][] = [];
    let currentBlock: string[] = [];

    for (const line of lines) {
      if (line === "--") {
        if (currentBlock.length > 0) blocks.push(currentBlock);
        currentBlock = [];
        continue;
      }
      currentBlock.push(line);
    }
    if (currentBlock.length > 0) blocks.push(currentBlock);

    const matches: ContentMatch[] = [];
    const seenMatches = new Map<string, number>();

    for (const block of blocks) {
      const entries = block
        .map((line) => parseSearchOutputLine(line))
        .filter((entry): entry is ParsedContentLine => entry !== null);

      const matchIndexes: number[] = [];
      for (let i = 0; i < entries.length; i++) {
        if (entries[i]?.kind === "match") {
          matchIndexes.push(i);
        }
      }

      for (let i = 0; i < matchIndexes.length; i++) {
        const matchIndex = matchIndexes[i];
        if (typeof matchIndex !== "number") continue;
        const matchEntry = entries[matchIndex];
        if (!matchEntry) continue;

        const key = `${matchEntry.file}:${matchEntry.line}`;

        const prevMatchIndex = i > 0 ? (matchIndexes[i - 1] ?? -1) : -1;
        const nextMatchIndex =
          i < matchIndexes.length - 1 ? (matchIndexes[i + 1] ?? entries.length) : entries.length;

        const contextBefore: ContextLine[] = [];
        const contextAfter: ContextLine[] = [];

        if (includeContext) {
          for (let j = prevMatchIndex + 1; j < matchIndex; j++) {
            const entry = entries[j];
            if (!entry || entry.kind !== "context" || entry.file !== matchEntry.file) continue;
            contextBefore.push({ line: entry.line, text: entry.text });
          }
          for (let j = matchIndex + 1; j < nextMatchIndex; j++) {
            const entry = entries[j];
            if (!entry || entry.kind !== "context" || entry.file !== matchEntry.file) continue;
            contextAfter.push({ line: entry.line, text: entry.text });
          }
        }

        const existingIndex = seenMatches.get(key);
        if (typeof existingIndex === "number") {
          if (!includeContext) continue;
          const existing = matches[existingIndex];
          if (!existing) continue;
          existing.contextBefore = mergeContextLines(existing.contextBefore, contextBefore);
          existing.contextAfter = mergeContextLines(existing.contextAfter, contextAfter);
          continue;
        }

        const item: ContentMatch = {
          file: matchEntry.file,
          line: matchEntry.line,
          text: matchEntry.text,
        };
        if (includeContext) {
          item.contextBefore = contextBefore;
          item.contextAfter = contextAfter;
        }
        seenMatches.set(key, matches.length);
        matches.push(item);
      }
    }

    return matches.slice(0, maxResults);
  }

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GrepArgs>({
    name: "grep",
    description:
      "Search INSIDE file contents (ripgrep if installed, else grep). Default: literal substring, recursive, 200 matches, content mode. " +
      "WHEN TO USE: where is this symbol/string? Prefer this over execute_command rg/grep. " +
      "WHEN NOT: locate files by name/glob → find (also advertised as glob). List one directory → ls. " +
      "Do not set both regex:true and a re: prefix. Recursive defaults to true with no depth cap — always pass path, never /. " +
      "Hidden files are skipped unless path points at them. With ripgrep, .gitignore is honoured; the grep fallback is not.",
    tags: ["search", "text"],
    parameters,
    validate: makeZodValidator(parameters),
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

        let result: CollectedProcessOutput;

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
            error: withGrepTruncationNote(
              `grep command failed: ${result.stderr}`,
              result.stderrTruncated,
            ),
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
              truncated: result.stdoutTruncated,
              message: withGrepTruncationNote(
                files.length === 0
                  ? `No files found matching pattern "${args.pattern}"`
                  : `Found ${files.length} files matching pattern "${args.pattern}"`,
                result.stdoutTruncated,
              ),
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
              truncated: result.stdoutTruncated,
              message: withGrepTruncationNote(
                counts.length === 0
                  ? `No matches found for pattern "${args.pattern}"`
                  : `Found matches in ${counts.length} files for pattern "${args.pattern}"`,
                result.stdoutTruncated,
              ),
            },
          };
        }

        // Content mode (default)
        const matches = parseContentOutput(
          result.stdout,
          maxResults,
          typeof args.contextLines === "number" && args.contextLines > 0,
        );
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
            truncated: result.stdoutTruncated,
            message: withGrepTruncationNote(
              matches.length === 0
                ? `No matches found for pattern "${args.pattern}"`
                : `Found ${matches.length} matches for pattern "${args.pattern}"${
                    args.contextLines ? ` (with ${args.contextLines} context lines)` : ""
                  }${requestedMaxResults > maxResults ? ` (capped at ${maxResults})` : ""}`,
              result.stdoutTruncated,
            ),
          },
        };
      }),
  });
}
