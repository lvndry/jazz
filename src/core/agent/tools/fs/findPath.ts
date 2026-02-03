import { spawn } from "child_process";
import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { Tool } from "@/core/interfaces/tool-registry";
import { createSanitizedEnv } from "@/core/utils/env-utils";
import { defineTool } from "../base-tool";
import { buildKeyFromContext } from "../context-utils";

/**
 * Find files by path pattern tool
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
        .describe("Paths to exclude from search (uses -prune, e.g., ['./node_modules', './.git'])"),
      caseSensitive: z
        .boolean()
        .optional()
        .describe("Use case-sensitive matching (default: false, uses -iname)"),
      regex: z
        .string()
        .optional()
        .describe("Regex pattern for name matching (overrides name if provided)"),
      maxDepth: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum search depth (default: 3)"),
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
          "Modification time filter (e.g., '-7' for last 7 days, '+30' for older than 30 days)",
        ),
      searchPath: z
        .string()
        .optional()
        .describe("Directory to start search from (defaults to current directory). NEVER use '/' as it's too broad and slow. Use current directory (omit this param) or a specific subdirectory."),
    })
    .strict()
    .refine((data) => data.name || data.pathPattern || data.regex, {
      message: "At least one of 'name', 'pathPattern', or 'regex' must be provided",
    });

  type FindPathParams = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, FindPathParams>({
    name: "find_path",
    description:
      "Advanced file search using find command syntax. Searches from current directory by default (or specific directory via searchPath). NEVER use searchPath: '/' as it's too broad and slow—always search from current directory or a specific subdirectory. Supports glob patterns, path matching, exclusions, regex, size/time filters, and depth control (default maxDepth: 3). Use for complex file searches similar to Unix 'find' command.",
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
        const shell = yield* FileSystemContextServiceTag;

        const currentDir = yield* shell.getCwd(buildKeyFromContext(context));
        const searchDir = args.searchPath
          ? yield* shell.resolvePath(buildKeyFromContext(context), args.searchPath)
          : currentDir;

        const maxDepth = args.maxDepth ?? 3;
        const minDepth = args.minDepth ?? 0;
        const searchType = args.type ?? "both";
        const caseSensitive = args.caseSensitive ?? false;

        // Build find command arguments
        const findArgs: string[] = [searchDir];

        // Add depth filters
        if (minDepth > 0) {
          findArgs.push("-mindepth", minDepth.toString());
        }
        findArgs.push("-maxdepth", maxDepth.toString());

        // Build the main expression parts
        const expressionParts: string[] = [];

        // Handle exclusions with -prune pattern
        // Format: -path './pattern' -prune -o (expression) -print
        // For multiple exclusions: -path './ex1' -prune -o -path './ex2' -prune -o (expression) -print
        if (args.excludePaths && args.excludePaths.length > 0) {
          for (const excludePath of args.excludePaths) {
            expressionParts.push("-path", excludePath);
            expressionParts.push("-prune");
            expressionParts.push("-o");
          }
        }

        // Add path pattern if specified (part of main expression, not an alternative)
        if (args.pathPattern) {
          expressionParts.push("-path", args.pathPattern);
        }

        // Add type filter
        if (searchType === "directory") {
          expressionParts.push("-type", "d");
        } else if (searchType === "file") {
          expressionParts.push("-type", "f");
        } else if (searchType === "symlink") {
          expressionParts.push("-type", "l");
        }

        // Add name/regex pattern matching
        if (args.regex) {
          // Use -regex for regex matching
          expressionParts.push("-regex", args.regex);
        } else if (args.name) {
          // Use glob pattern directly if it contains wildcards, otherwise wrap for partial matching
          const pattern =
            args.name.includes("*") || args.name.includes("?") || args.name.includes("[")
              ? args.name
              : `*${args.name}*`;
          const nameFlag = caseSensitive ? "-name" : "-iname";
          expressionParts.push(nameFlag, pattern);
        }

        // Add size filter
        if (args.size) {
          expressionParts.push("-size", args.size);
        }

        // Add modification time filter
        if (args.mtime) {
          expressionParts.push("-mtime", args.mtime);
        }

        // Add -print at the end (required when using -prune)
        if (args.excludePaths && args.excludePaths.length > 0) {
          expressionParts.push("-print");
        }

        // Combine all arguments
        if (expressionParts.length > 0) {
          findArgs.push(...expressionParts);
        }

        // Execute the find command using proper argument passing (no shell injection risk)
        const result = yield* Effect.promise<{
          stdout: string;
          stderr: string;
          exitCode: number;
        }>(
          () =>
            new Promise((resolve, reject) => {
              const sanitizedEnv = createSanitizedEnv();
              const child = spawn("find", findArgs, {
                cwd: currentDir,
                stdio: ["ignore", "pipe", "pipe"],
                env: sanitizedEnv,
                timeout: 30_000,
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

        if (result.exitCode !== 0) {
          return {
            success: false,
            result: null,
            error: `find command failed: ${result.stderr}`,
          };
        }

        // Parse results
        const paths = result.stdout
          .split("\n")
          .filter((line) => line.trim())
          .map((path) => {
            const name = path.split("/").pop() || "";
            // Determine type by checking if it's a directory
            // We'll use a simple heuristic: if it doesn't have an extension and is likely a dir
            const isDir = !name.includes(".") || name.endsWith("/");
            return {
              path: path.trim(),
              name,
              type: isDir ? "dir" : "file",
            };
          });

        return {
          success: true,
          result: {
            searchTerm: args.name,
            currentDirectory: currentDir,
            searchDirectory: searchDir,
            maxDepth,
            type: searchType,
            results: paths.slice(0, 50),
            totalFound: paths.length,
            message:
              paths.length === 0
                ? `No ${searchType === "both" ? "items" : searchType + "s"} found matching "${args.name}"`
                : `Found ${paths.length} ${searchType === "both" ? "items" : searchType + "s"} matching "${args.name}"`,
          },
        };
      }),
  });
}
