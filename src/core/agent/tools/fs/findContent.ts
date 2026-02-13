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
 * Combined find + grep: find files matching a name/glob pattern that also
 * contain a content pattern — all in a single tool call.
 *
 * This saves a full LLM round-trip compared to chaining `find` then `grep`,
 * and reduces token usage because the agent doesn't need to relay the
 * intermediate file list.
 *
 * Under the hood it uses ripgrep's `--glob` filtering (preferred) or falls
 * back to `grep --include` when rg is unavailable.
 */

export function createFindContentTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      contentPattern: z
        .string()
        .min(1)
        .describe("Pattern to search for inside files (literal or 're:<regex>')"),
      filePattern: z
        .string()
        .min(1)
        .describe(
          "Glob pattern to restrict which files to search (e.g., '*.ts', '*.{js,jsx}', 'test_*')",
        ),
      path: z
        .string()
        .optional()
        .describe("Directory to search in (defaults to current working directory)"),
      regex: z
        .boolean()
        .optional()
        .describe("Treat contentPattern as regex (overrides the re: prefix)"),
      ignoreCase: z.boolean().optional().describe("Case-insensitive content matching"),
      maxResults: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max matches to return (default: 200, hard cap: 2000)"),
      maxDepth: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum directory depth to search (default: 25)"),
      excludeDir: z
        .string()
        .optional()
        .describe("Directory pattern to exclude (e.g., 'node_modules', '.git')"),
      contextLines: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Number of context lines above/below each match"),
    })
    .strict();

  type FindContentArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, FindContentArgs>({
    name: "find_content",
    description:
      "Find files matching a glob pattern that contain a specific text or regex pattern — combines file search and content search in a single operation. Saves a round-trip vs. chaining find + grep. Uses ripgrep when available (fast, multi-threaded, .gitignore-aware) with automatic fallback to system grep. Returns matching lines with file paths and line numbers. Defaults to 200 results (hard cap 2000).",
    tags: ["search", "text", "filesystem"],
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

        const searchDir = args.path
          ? yield* shell.resolvePath(buildKeyFromContext(context), args.path)
          : yield* shell.getCwd(buildKeyFromContext(context));

        // Validate path
        const stat = yield* fs.stat(searchDir).pipe(Effect.catchAll(() => Effect.succeed(null)));
        if (!stat || stat.type !== "Directory") {
          return yield* Effect.fail(
            new Error(`Path does not exist or is not a directory: ${searchDir}`),
          );
        }

        const requestedMaxResults =
          typeof args.maxResults === "number" && args.maxResults > 0 ? args.maxResults : 200;
        const maxResults = Math.min(requestedMaxResults, 2000);
        const maxDepth = args.maxDepth ?? 25;
        const sanitizedEnv = createSanitizedEnv();

        // Determine search pattern
        const isRegex = args.regex === true || args.contentPattern.startsWith("re:");
        const rawPattern = isRegex
          ? args.regex === true
            ? args.contentPattern
            : args.contentPattern.slice(3) || ""
          : args.contentPattern;

        const useRipgrep = yield* Effect.promise(() => checkExternalTool("rg"));

        let result: { stdout: string; stderr: string; exitCode: number };

        if (useRipgrep) {
          const rgArgs: string[] = [];

          // File pattern filter
          rgArgs.push("-g", args.filePattern);

          // Depth
          rgArgs.push("--max-depth", maxDepth.toString());

          // Options
          if (args.ignoreCase) rgArgs.push("-i");
          rgArgs.push("-n"); // line numbers
          rgArgs.push("-m", maxResults.toString());

          if (typeof args.contextLines === "number" && args.contextLines > 0) {
            rgArgs.push("-C", args.contextLines.toString());
          }

          if (args.excludeDir) rgArgs.push("-g", `!${args.excludeDir}/`);

          if (!isRegex) rgArgs.push("--fixed-strings");

          rgArgs.push(rawPattern, searchDir);

          result = yield* spawnCollect("rg", rgArgs, {
            cwd: searchDir,
            env: sanitizedEnv,
            timeout: 30_000,
          });

          // Fallback to system grep on unexpected failure
          if (result.exitCode > 1) {
            const grepArgs = buildGrepFallbackArgs(
              rawPattern,
              isRegex,
              args,
              maxResults,
              searchDir,
            );
            result = yield* spawnCollect("grep", grepArgs, {
              cwd: searchDir,
              env: sanitizedEnv,
              timeout: 30_000,
            });
          }
        } else {
          const grepArgs = buildGrepFallbackArgs(rawPattern, isRegex, args, maxResults, searchDir);
          result = yield* spawnCollect("grep", grepArgs, {
            cwd: searchDir,
            env: sanitizedEnv,
            timeout: 30_000,
          });
        }

        if (result.exitCode !== 0 && result.exitCode !== 1) {
          return {
            success: false,
            result: null,
            error: `Search failed: ${result.stderr}`,
          };
        }

        // Parse matches
        const lines = result.stdout.split("\n").filter((l) => l.trim());
        const matches: Array<{ file: string; line: number; text: string }> = [];
        const seen = new Set<string>();

        for (const line of lines) {
          if (line === "--") continue;
          const parts = line.split(":");
          if (parts.length >= 3 && parts[0] && parts[1]) {
            const file = parts[0];
            const lineNum = parseInt(parts[1], 10);
            const text = parts.slice(2).join(":");
            const key = `${file}:${lineNum}`;
            if (!seen.has(key)) {
              seen.add(key);
              matches.push({ file, line: lineNum, text });
            }
          }
        }

        const trimmed = matches.slice(0, maxResults);

        return {
          success: true,
          result: {
            contentPattern: args.contentPattern,
            filePattern: args.filePattern,
            searchPath: searchDir,
            backend: useRipgrep ? "ripgrep" : "grep",
            matches: trimmed,
            totalFound: trimmed.length,
            message:
              trimmed.length === 0
                ? `No matches found for "${args.contentPattern}" in files matching "${args.filePattern}"`
                : `Found ${trimmed.length} matches for "${args.contentPattern}" in files matching "${args.filePattern}"${
                    args.contextLines ? ` (with ${args.contextLines} context lines)` : ""
                  }`,
          },
        };
      }),
  });
}

/** Build grep fallback arguments for the combined find+content search. */
function buildGrepFallbackArgs(
  pattern: string,
  isRegex: boolean,
  args: {
    filePattern: string;
    ignoreCase?: boolean | undefined;
    excludeDir?: string | undefined;
    contextLines?: number | undefined;
  },
  maxResults: number,
  searchDir: string,
): string[] {
  const grepArgs: string[] = ["-r", "-n"];

  if (args.ignoreCase) grepArgs.push("-i");
  if (isRegex) grepArgs.push("-E");
  else grepArgs.push("-F");

  grepArgs.push("--include", args.filePattern);
  if (args.excludeDir) grepArgs.push("--exclude-dir", args.excludeDir);
  grepArgs.push("-m", maxResults.toString());

  if (typeof args.contextLines === "number" && args.contextLines > 0) {
    grepArgs.push("-C", args.contextLines.toString());
  }

  grepArgs.push(pattern, searchDir);
  return grepArgs;
}
