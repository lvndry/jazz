import { FileSystem } from "@effect/platform";
import { spawn } from "child_process";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "../../../interfaces/fs";
import type { Tool } from "../../../interfaces/tool-registry";
import { createSanitizedEnv } from "../../../utils/env-utils";
import { defineTool } from "../base-tool";
import { buildKeyFromContext } from "../context-utils";

/**
 * Search file contents with patterns tool
 */

export function createGrepTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      pattern: z.string().min(1).describe("Search pattern (literal or 're:<regex>')"),
      path: z.string().optional().describe("File or directory to search (defaults to cwd)"),
      recursive: z.boolean().optional().describe("Recurse into directories"),
      regex: z.boolean().optional().describe("Treat pattern as regex (overrides re:<...>)"),
      ignoreCase: z.boolean().optional().describe("Case-insensitive match"),
      maxResults: z.number().int().positive().optional().describe("Max matches to return"),
      filePattern: z
        .string()
        .optional()
        .describe("File pattern to search in (e.g., '*.js', '*.ts'). Uses --include flag."),
      exclude: z
        .string()
        .optional()
        .describe(
          "Exclude files matching this pattern (e.g., '*.min.js', '*.log'). Uses --exclude flag.",
        ),
      excludeDir: z
        .string()
        .optional()
        .describe(
          "Exclude directories matching this pattern (e.g., 'node_modules', '.git'). Uses --exclude-dir flag.",
        ),
      contextLines: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Number of context lines to show above and below each match. Use this to see surrounding content when searching for patterns.",
        ),
    })
    .strict();

  type GrepArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GrepArgs>({
    name: "grep",
    description:
      "Search for text patterns within file contents using grep. Supports literal strings and regex patterns. Use to find specific code, text, or patterns across files. Returns matching lines with file paths and line numbers. **Tip: Use contextLines and filters to have more precise results.**",
    tags: ["search", "text"],
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
        const start = args.path
          ? yield* shell.resolvePath(buildKeyFromContext(context), args.path)
          : yield* shell.getCwd(buildKeyFromContext(context));
        const recursive = args.recursive !== false;
        const maxResults =
          typeof args.maxResults === "number" && args.maxResults > 0 ? args.maxResults : 5000;

        // Check if the path exists and determine if it's a file or directory
        const stat = yield* fs.stat(start).pipe(Effect.catchAll(() => Effect.succeed(null)));

        if (stat === null) {
          return yield* Effect.fail(new Error(`Path does not exist: ${start}`));
        }

        // Determine the working directory and search path
        let workingDir: string;
        let searchPath: string;

        if (stat.type === "Directory") {
          workingDir = start;
          searchPath = start;
        } else if (stat.type === "File") {
          // If it's a file, use its parent directory as working directory and the file as search path
          const pathModule = yield* Effect.promise(() => import("path"));
          workingDir = pathModule.dirname(start);
          searchPath = start;
        } else {
          workingDir = start;
          searchPath = start;
        }

        // Build grep command arguments
        const grepArgs: string[] = [];

        // Add recursive flag (only if searching a directory)
        if (recursive && stat.type === "Directory") {
          grepArgs.push("-r");
        }

        // Add case sensitivity
        if (args.ignoreCase) {
          grepArgs.push("-i");
        }

        // Add line numbers
        grepArgs.push("-n");

        // Add context lines if specified (highly recommended for better code understanding)
        if (typeof args.contextLines === "number" && args.contextLines > 0) {
          grepArgs.push("-C", args.contextLines.toString());
        }

        // Add file pattern if specified (include)
        if (args.filePattern) {
          grepArgs.push("--include", args.filePattern);
        }

        // Add exclude file pattern if specified
        if (args.exclude) {
          grepArgs.push("--exclude", args.exclude);
        }

        // Add exclude directory pattern if specified
        if (args.excludeDir) {
          grepArgs.push("--exclude-dir", args.excludeDir);
        }

        // Add max count to limit results
        grepArgs.push("-m", maxResults.toString());

        // Determine if pattern is regex
        let searchPattern: string;
        if (args.regex === true || args.pattern.startsWith("re:")) {
          const source = args.regex === true ? args.pattern : args.pattern.slice(3) || "";
          searchPattern = source;
          grepArgs.push("-E"); // Extended regex
        } else {
          searchPattern = args.pattern;
          grepArgs.push("-F"); // Fixed string
        }

        // Add the search pattern and path
        grepArgs.push(searchPattern, searchPath);

        // Execute the grep command using proper argument passing (no shell injection risk)
        const result = yield* Effect.promise<{
          stdout: string;
          stderr: string;
          exitCode: number;
        }>(
          () =>
            new Promise((resolve, reject) => {
              const sanitizedEnv = createSanitizedEnv();
              const child = spawn("grep", grepArgs, {
                cwd: workingDir,
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

        // Grep returns exit code 1 when no matches are found, which is normal
        if (result.exitCode !== 0 && result.exitCode !== 1) {
          return {
            success: false,
            result: null,
            error: `grep command failed: ${result.stderr}`,
          };
        }

        // Parse results
        // When contextLines is used, grep adds "--" separators between match groups
        const lines = result.stdout.split("\n").filter((line) => line.trim());
        const matches: Array<{ file: string; line: number; text: string }> = [];
        const seenMatches = new Set<string>(); // Track unique file:line combinations to avoid duplicates

        for (const line of lines) {
          // Skip separator lines added by grep -C
          if (line === "--") continue;

          // Parse format: file:line:content
          const parts = line.split(":");
          if (parts.length >= 3 && parts[0] && parts[1]) {
            const file = parts[0];
            const lineNum = parseInt(parts[1], 10);
            const text = parts.slice(2).join(":");
            const key = `${file}:${lineNum}`;

            // Avoid duplicate matches when context lines are used
            if (!seenMatches.has(key)) {
              seenMatches.add(key);
              matches.push({
                file,
                line: lineNum,
                text,
              });
            }
          }
        }

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
            matches: matches.slice(0, maxResults),
            totalFound: matches.length,
            message:
              matches.length === 0
                ? `No matches found for pattern "${args.pattern}"`
                : `Found ${matches.length} matches for pattern "${args.pattern}"${
                    args.contextLines ? ` (with ${args.contextLines} context lines)` : ""
                  }`,
          },
        };
      }),
  });
}
