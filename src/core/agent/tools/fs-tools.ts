import { FileSystem } from "@effect/platform";
import { spawn } from "child_process";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "../../interfaces/fs";
import type { Tool } from "../../interfaces/tool-registry";
import { createSanitizedEnv } from "../../utils/env-utils";
import { defineTool } from "./base-tool";
import { buildKeyFromContext } from "./context-utils";

/**
 * Filesystem and shell tools: pwd, ls, cd, grep, find, mkdir, rm
 * mkdir and rm require explicit approval and are executed via hidden execute_* tools.
 */

function normalizeFilterPattern(pattern?: string): {
  type: "substring" | "regex";
  value?: string;
  regex?: RegExp;
} {
  if (!pattern || pattern.trim() === "") return { type: "substring" };
  const trimmed = pattern.trim();
  if (trimmed.startsWith("re:")) {
    const body = trimmed.slice(3);
    try {
      return { type: "regex", regex: new RegExp(body) };
    } catch {
      return { type: "substring", value: body };
    }
  }

  return { type: "substring", value: trimmed };
}

function normalizeStatSize(size: unknown): number | string | null {
  if (typeof size === "bigint") {
    const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
    if (size <= maxSafe && size >= -maxSafe) {
      return Number(size);
    }

    return size.toString();
  }

  if (typeof size === "number") {
    return size;
  }

  if (typeof size === "string") {
    return size;
  }

  return null;
}

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
        .describe("Directory to start search from (defaults to current directory)"),
    })
    .strict()
    .refine((data) => data.name || data.pathPattern || data.regex, {
      message: "At least one of 'name', 'pathPattern', or 'regex' must be provided",
    });

  return defineTool<
    FileSystem.FileSystem | FileSystemContextService,
    {
      name?: string;
      pathPattern?: string;
      excludePaths?: string[];
      caseSensitive?: boolean;
      regex?: string;
      maxDepth?: number;
      minDepth?: number;
      type?: "directory" | "file" | "both" | "symlink";
      size?: string;
      mtime?: string;
      searchPath?: string;
    }
  >({
    name: "find_path",
    description:
      "Advanced file search using find command syntax. Supports glob patterns, path matching, exclusions, regex, size/time filters, and depth control. Use for complex file searches similar to Unix 'find' command.",
    tags: ["filesystem", "search"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({
            valid: true,
            value: params.data as unknown as {
              name?: string;
              pathPattern?: string;
              excludePaths?: string[];
              caseSensitive?: boolean;
              regex?: string;
              maxDepth?: number;
              minDepth?: number;
              type?: "directory" | "file" | "both" | "symlink";
              size?: string;
              mtime?: string;
              searchPath?: string;
            },
          } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
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
        if (args.excludePaths && args.excludePaths.length > 0) {
          for (const excludePath of args.excludePaths) {
            expressionParts.push("-path", excludePath);
            expressionParts.push("-prune");
            expressionParts.push("-o");
          }
        }

        // Add path pattern if specified
        if (args.pathPattern) {
          expressionParts.push("-path", args.pathPattern);
          expressionParts.push("-o");
        }

        // Add type filter
        if (searchType === "directory") {
          expressionParts.push("-type", "d");
        } else if (searchType === "file") {
          expressionParts.push("-type", "f");
        } else if (searchType === "symlink") {
          expressionParts.push("-type", "l");
        }
        // "both" doesn't add a type filter

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
              type: isDir ? ("dir" as const) : ("file" as const),
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

// pwd
export function createPwdTool(): Tool<FileSystemContextService> {
  const parameters = z.object({}).strict();
  return defineTool<FileSystemContextService, Record<string, never>>({
    name: "pwd",
    description: "Print the current working directory for this agent session",
    tags: ["filesystem", "navigation"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data as unknown as Record<string, never> } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: (_args, context) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const cwd = yield* shell.getCwd(buildKeyFromContext(context));
        return { success: true, result: cwd };
      }),
  });
}

// ls
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

  return defineTool<
    FileSystem.FileSystem | FileSystemContextService,
    {
      path?: string;
      showHidden?: boolean;
      recursive?: boolean;
      pattern?: string;
      maxResults?: number;
    }
  >({
    name: "ls",
    description:
      "List files and directories within a specified path. Supports recursive traversal, filtering by name patterns (substring or regex), showing hidden files, and limiting results. Returns file/directory names, paths, and types.",
    tags: ["filesystem", "listing"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({
            valid: true,
            value: params.data as unknown as {
              path?: string;
              showHidden?: boolean;
              recursive?: boolean;
              pattern?: string;
              maxResults?: number;
            },
          } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
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

// cd
export function createCdTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z.string().min(1).describe("Path to change directory to"),
    })
    .strict();

  return defineTool<FileSystem.FileSystem | FileSystemContextService, { path: string }>({
    name: "cd",
    description: "Change the current working directory for this agent session",
    tags: ["filesystem", "navigation"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data as unknown as { path: string } } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const shell = yield* FileSystemContextServiceTag;

        const target = yield* shell
          .resolvePath(buildKeyFromContext(context), args.path)
          .pipe(Effect.catchAll(() => Effect.succeed(null)));

        if (target === null) {
          return {
            success: false,
            result: null,
            error: `Path not found: ${args.path}`,
          };
        }

        try {
          const stat = yield* fs.stat(target);
          if (stat.type !== "Directory") {
            return { success: false, result: null, error: `Not a directory: ${target}` };
          }
          yield* shell.setCwd(buildKeyFromContext(context), target);
          return { success: true, result: target };
        } catch (error) {
          return {
            success: false,
            result: null,
            error: `cd failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }),
  });
}

// readFile
export function createReadFileTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z.string().min(1).describe("File path to read (relative to cwd allowed)"),
      startLine: z.number().int().positive().optional().describe("1-based start line (inclusive)"),
      endLine: z.number().int().positive().optional().describe("1-based end line (inclusive)"),
      maxBytes: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of bytes to return (content is truncated if exceeded)"),
      encoding: z.string().optional().describe("Text encoding (currently utf-8)"),
    })
    .strict();

  return defineTool<
    FileSystem.FileSystem | FileSystemContextService,
    { path: string; startLine?: number; endLine?: number; maxBytes?: number; encoding?: string }
  >({
    name: "read_file",
    description:
      "Read the contents of a text file with optional line range selection (startLine/endLine). Automatically handles UTF-8 BOM, enforces size limits to prevent memory issues (default 128KB), and reports truncation. Returns file content, encoding, line counts, and range information.",
    tags: ["filesystem", "read"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({
            valid: true,
            value: params.data as unknown as {
              path: string;
              startLine?: number;
              endLine?: number;
              maxBytes?: number;
              encoding?: string;
            },
          } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const shell = yield* FileSystemContextServiceTag;
        const filePathResult = yield* shell
          .resolvePath(buildKeyFromContext(context), args.path)
          .pipe(Effect.catchAll(() => Effect.succeed(null)));

        if (filePathResult === null) {
          return {
            success: false,
            result: null,
            error: `Path not found: ${args.path}`,
          };
        }

        try {
          const stat = yield* fs.stat(filePathResult);
          if (stat.type === "Directory") {
            return { success: false, result: null, error: `Not a file: ${filePathResult}` };
          }

          let content = yield* fs.readFileString(filePathResult);

          // Strip UTF-8 BOM if present
          if (content.length > 0 && content.charCodeAt(0) === 0xfeff) {
            content = content.slice(1);
          }

          let totalLines = 0;
          let returnedLines = 0;
          let rangeStart: number | undefined = undefined;
          let rangeEnd: number | undefined = undefined;

          // Apply line range if provided
          if (args.startLine !== undefined || args.endLine !== undefined) {
            const lines = content.split(/\r?\n/);
            totalLines = lines.length;
            const start = Math.max(1, args.startLine ?? 1);
            const rawEnd = args.endLine ?? totalLines;
            const end = Math.max(start, Math.min(rawEnd, totalLines));
            content = lines.slice(start - 1, end).join("\n");
            returnedLines = end - start + 1;
            rangeStart = start;
            rangeEnd = end;
          } else {
            // If no range, we can still report total lines lazily without splitting twice
            totalLines = content === "" ? 0 : content.split(/\r?\n/).length;
            returnedLines = totalLines;
          }

          // Enforce maxBytes safeguard (approximate by string length)
          const maxBytes =
            typeof args.maxBytes === "number" && args.maxBytes > 0 ? args.maxBytes : 131072;
          let truncated = false;
          if (content.length > maxBytes) {
            content = content.slice(0, maxBytes);
            truncated = true;
          }

          return {
            success: true,
            result: {
              path: filePathResult,
              encoding: (args.encoding ?? "utf-8").toLowerCase(),
              content,
              truncated,
              totalLines,
              returnedLines,
              range:
                rangeStart !== undefined ? { startLine: rangeStart, endLine: rangeEnd } : undefined,
            },
          };
        } catch (error) {
          return {
            success: false,
            result: null,
            error: `readFile failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }),
  });
}

// head
export function createHeadTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z.string().min(1).describe("File path to read (relative to cwd allowed)"),
      lines: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Number of lines to return from the beginning (default: 10)"),
      maxBytes: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of bytes to read (content is truncated if exceeded)"),
    })
    .strict();

  return defineTool<
    FileSystem.FileSystem | FileSystemContextService,
    { path: string; lines?: number; maxBytes?: number }
  >({
    name: "head",
    description:
      "Read the first N lines of a file (default: 10). Useful for quickly viewing the beginning of a file without reading the entire contents. Returns file content, line counts, and metadata.",
    tags: ["filesystem", "read"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({
            valid: true,
            value: params.data as unknown as {
              path: string;
              lines?: number;
              maxBytes?: number;
            },
          } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const shell = yield* FileSystemContextServiceTag;
        const filePathResult = yield* shell
          .resolvePath(buildKeyFromContext(context), args.path)
          .pipe(Effect.catchAll(() => Effect.succeed(null)));

        // If path resolution failed, return the error
        if (filePathResult === null) {
          return {
            success: false,
            result: null,
            error: `Path not found: ${args.path}`,
          };
        }

        try {
          const stat = yield* fs.stat(filePathResult);
          if (stat.type === "Directory") {
            return { success: false, result: null, error: `Not a file: ${filePathResult}` };
          }

          let content = yield* fs.readFileString(filePathResult);

          // Strip UTF-8 BOM if present
          if (content.length > 0 && content.charCodeAt(0) === 0xfeff) {
            content = content.slice(1);
          }

          const lines = content.split(/\r?\n/);
          const totalLines = lines.length;
          const requestedLines = args.lines ?? 10;
          const returnedLines = Math.min(requestedLines, totalLines);

          // Enforce maxBytes safeguard (approximate by string length)
          const maxBytes =
            typeof args.maxBytes === "number" && args.maxBytes > 0 ? args.maxBytes : 131072;
          let truncated = false;
          let headContent = lines.slice(0, returnedLines).join("\n");

          if (headContent.length > maxBytes) {
            headContent = headContent.slice(0, maxBytes);
            truncated = true;
          }

          return {
            success: true,
            result: {
              path: filePathResult,
              content: headContent,
              truncated,
              totalLines,
              returnedLines,
              requestedLines,
            },
          };
        } catch (error) {
          return {
            success: false,
            result: null,
            error: `head failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }),
  });
}

// tail
export function createTailTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z.string().min(1).describe("File path to read (relative to cwd allowed)"),
      lines: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Number of lines to return from the end (default: 10)"),
      maxBytes: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of bytes to read (content is truncated if exceeded)"),
    })
    .strict();

  return defineTool<
    FileSystem.FileSystem | FileSystemContextService,
    { path: string; lines?: number; maxBytes?: number }
  >({
    name: "tail",
    description:
      "Read the last N lines of a file (default: 10). Useful for quickly viewing the end of a file, such as log files or recent entries. Returns file content, line counts, and metadata.",
    tags: ["filesystem", "read"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({
            valid: true,
            value: params.data as unknown as {
              path: string;
              lines?: number;
              maxBytes?: number;
            },
          } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const shell = yield* FileSystemContextServiceTag;
        const filePathResult = yield* shell
          .resolvePath(buildKeyFromContext(context), args.path)
          .pipe(Effect.catchAll(() => Effect.succeed(null)));

        // If path resolution failed, return the error
        if (filePathResult === null) {
          return {
            success: false,
            result: null,
            error: `Path not found: ${args.path}`,
          };
        }

        try {
          const stat = yield* fs.stat(filePathResult);
          if (stat.type === "Directory") {
            return { success: false, result: null, error: `Not a file: ${filePathResult}` };
          }

          let content = yield* fs.readFileString(filePathResult);

          // Strip UTF-8 BOM if present
          if (content.length > 0 && content.charCodeAt(0) === 0xfeff) {
            content = content.slice(1);
          }

          const lines = content.split(/\r?\n/);
          const totalLines = lines.length;
          const requestedLines = args.lines ?? 10;
          const returnedLines = Math.min(requestedLines, totalLines);

          // Get the last N lines
          const startIndex = Math.max(0, totalLines - returnedLines);
          let tailContent = lines.slice(startIndex).join("\n");

          // Enforce maxBytes safeguard (approximate by string length)
          const maxBytes =
            typeof args.maxBytes === "number" && args.maxBytes > 0 ? args.maxBytes : 131072;
          let truncated = false;

          if (tailContent.length > maxBytes) {
            tailContent = tailContent.slice(-maxBytes);
            truncated = true;
          }

          return {
            success: true,
            result: {
              path: filePathResult,
              content: tailContent,
              truncated,
              totalLines,
              returnedLines,
              requestedLines,
              startLine: startIndex + 1, // 1-based line number
              endLine: totalLines,
            },
          };
        } catch (error) {
          return {
            success: false,
            result: null,
            error: `tail failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }),
  });
}

// writeFile (approval required)
type WriteFileArgs = { path: string; content: string; encoding?: string; createDirs?: boolean };

export function createWriteFileTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z
        .string()
        .min(1)
        .describe(
          "File path to write to, will be created if it doesn't exist (relative to cwd allowed)",
        ),
      content: z.string().describe("Content to write to the file"),
      encoding: z.string().optional().describe("Text encoding (currently utf-8)"),
      createDirs: z.boolean().optional().describe("Create parent directories if they don't exist"),
    })
    .strict();

  return defineTool<FileSystem.FileSystem | FileSystemContextService, WriteFileArgs>({
    name: "write_file",
    description:
      "Write content to a file, creating it if it doesn't exist (requires user approval)",
    tags: ["filesystem", "write"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data as unknown as WriteFileArgs } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    approval: {
      message: (args, context) =>
        Effect.gen(function* () {
          const shell = yield* FileSystemContextServiceTag;
          const target = yield* shell.resolvePath(buildKeyFromContext(context), args.path, {
            skipExistenceCheck: true,
          });
          return `About to write to file: ${target}${args.createDirs === true ? " (will create parent directories)" : ""}.\n\nIMPORTANT: After getting user confirmation, you MUST call the execute_write_file tool with these exact arguments: {"path": "${args.path}", "content": ${JSON.stringify(args.content)}, "encoding": "${args.encoding ?? "utf-8"}", "createDirs": ${args.createDirs === true}}`;
        }),
      errorMessage: "Approval required: File writing requires user confirmation.",
      execute: {
        toolName: "execute_write_file",
        buildArgs: (args) => ({
          path: args.path,
          content: args.content,
          encoding: args.encoding,
          createDirs: args.createDirs,
        }),
      },
    },
    handler: (_args) =>
      Effect.succeed({ success: false, result: null, error: "Approval required" }),
  });
}

export function createExecuteWriteFileTool(): Tool<
  FileSystem.FileSystem | FileSystemContextService
> {
  const parameters = z
    .object({
      path: z
        .string()
        .min(1)
        .describe("File path to write to, will be created if it doesn't exist"),
      content: z.string().describe("Content to write to the file"),
      encoding: z.string().optional().describe("Text encoding (currently utf-8)"),
      createDirs: z.boolean().optional().describe("Create parent directories if they don't exist"),
    })
    .strict();

  return defineTool<FileSystem.FileSystem | FileSystemContextService, WriteFileArgs>({
    name: "execute_write_file",
    description:
      "Executes the actual file write operation after user approval of write_file. Creates or overwrites the file at the specified path with the provided content. This tool is called after write_file receives user approval.",
    hidden: true,
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data as unknown as WriteFileArgs } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const shell = yield* FileSystemContextServiceTag;
        const target = yield* shell.resolvePath(buildKeyFromContext(context), args.path, {
          skipExistenceCheck: true,
        });

        try {
          const parentDir = target.substring(0, target.lastIndexOf("/"));
          if (parentDir && parentDir !== target) {
            const parentExists = yield* fs
              .exists(parentDir)
              .pipe(Effect.catchAll(() => Effect.succeed(false)));

            if (!parentExists) {
              yield* fs.makeDirectory(parentDir, { recursive: true });
            }
          }

          // Write the file content
          yield* fs.writeFileString(target, args.content);

          return { success: true, result: `File written: ${target}` };
        } catch (error) {
          return {
            success: false,
            result: null,
            error: `writeFile failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }),
  });
}

// editFile (approval required)
type EditOperation =
  | {
      type: "replace_lines";
      startLine: number;
      endLine: number;
      content: string;
    }
  | {
      type: "replace_pattern";
      pattern: string;
      replacement: string;
      count?: number;
    }
  | {
      type: "insert";
      line: number;
      content: string;
    }
  | {
      type: "delete_lines";
      startLine: number;
      endLine: number;
    };

type EditFileArgs = {
  path: string;
  edits: EditOperation[];
  encoding?: string;
};

export function createEditFileTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const editOperationSchema = z.discriminatedUnion("type", [
    z
      .object({
        type: z.literal("replace_lines"),
        startLine: z
          .number()
          .int()
          .positive()
          .describe("Starting line number (1-based, inclusive)"),
        endLine: z.number().int().positive().describe("Ending line number (1-based, inclusive)"),
        content: z.string().describe("New content to replace the specified lines"),
      })
      .refine((data) => data.startLine <= data.endLine, {
        message: "startLine must be less than or equal to endLine",
      }),
    z.object({
      type: z.literal("replace_pattern"),
      pattern: z
        .string()
        .min(1)
        .describe(
          "Pattern to find (literal string or 're:<regex>' for regex patterns, e.g., 're:function\\s+\\w+')",
        ),
      replacement: z.string().describe("Replacement text"),
      count: z
        .number()
        .int()
        .optional()
        .describe("Number of occurrences to replace (default: 1, use -1 for all occurrences)"),
    }),
    z.object({
      type: z.literal("insert"),
      line: z
        .number()
        .int()
        .nonnegative()
        .describe("Line number to insert after (0-based: 0 = before first line, 1 = after line 1)"),
      content: z.string().describe("Content to insert"),
    }),
    z
      .object({
        type: z.literal("delete_lines"),
        startLine: z
          .number()
          .int()
          .positive()
          .describe("Starting line number (1-based, inclusive)"),
        endLine: z.number().int().positive().describe("Ending line number (1-based, inclusive)"),
      })
      .refine((data) => data.startLine <= data.endLine, {
        message: "startLine must be less than or equal to endLine",
      }),
  ]);

  const parameters = z
    .object({
      path: z
        .string()
        .min(1)
        .describe("File path to edit (relative to cwd allowed, file must exist)"),
      edits: z
        .array(editOperationSchema)
        .min(1)
        .describe(
          "Array of edit operations to perform. Operations are applied in order. Use replace_lines when you know exact line numbers (from read_file, head, tail, grep). Use replace_pattern to find and replace text patterns. Use insert to add new content. Use delete_lines to remove lines.",
        ),
      encoding: z.string().optional().describe("Text encoding (default: utf-8)"),
    })
    .strict();

  return defineTool<FileSystem.FileSystem | FileSystemContextService, EditFileArgs>({
    name: "edit_file",
    description:
      "Edit specific parts of a file without rewriting the entire file. Supports multiple edit operations in one call: replace lines by line numbers, replace patterns (regex or literal), insert content at specific lines, or delete lines. Use this when you need to make targeted changes to a file. For line-based edits, use line numbers from read_file, head, tail, or grep. For pattern-based edits, use patterns to find and replace text. All edits are applied in order. Requires user approval.",
    tags: ["filesystem", "write", "edit"],
    parameters,
    validate: (args) => {
      const result = parameters.safeParse(args);
      return result.success
        ? ({ valid: true, value: result.data as unknown as EditFileArgs } as const)
        : ({ valid: false, errors: result.error.issues.map((i) => i.message) } as const);
    },
    approval: {
      message: (args, context) =>
        Effect.gen(function* () {
          const shell = yield* FileSystemContextServiceTag;
          const target = yield* shell.resolvePath(buildKeyFromContext(context), args.path);

          // Read the file to show context
          const fs = yield* FileSystem.FileSystem;
          let fileContent = "";
          let totalLines = 0;
          const fileExists = yield* fs
            .exists(target)
            .pipe(Effect.catchAll(() => Effect.succeed(false)));

          if (!fileExists) {
            return `WARNING: File does not exist: ${target}\n\nCannot edit a file that doesn't exist. Please create the file first or check the path.`;
          }

          try {
            fileContent = yield* fs.readFileString(target);
            totalLines = fileContent.split("\n").length;
          } catch {
            return `WARNING: File exists but cannot be read: ${target}\n\nPlease check file permissions.`;
          }

          const editDescriptions = args.edits.map((edit, idx) => {
            switch (edit.type) {
              case "replace_lines":
                return `  ${idx + 1}. Replace lines ${edit.startLine}-${edit.endLine} with new content (${edit.content.split("\n").length} lines)`;
              case "replace_pattern":
                return `  ${idx + 1}. Replace pattern "${edit.pattern}" with "${edit.replacement}"${edit.count ? ` (${edit.count} occurrence${edit.count === 1 ? "" : "s"})` : " (first occurrence)"}`;
              case "insert":
                return `  ${idx + 1}. Insert content after line ${edit.line} (${edit.content.split("\n").length} lines)`;
              case "delete_lines":
                return `  ${idx + 1}. Delete lines ${edit.startLine}-${edit.endLine}`;
            }
          });

          const summary = `About to edit file: ${target} (${totalLines} lines total)\n\nEdits to perform:\n${editDescriptions.join("\n")}\n\nIMPORTANT: After getting user confirmation, you MUST call the execute_edit_file tool with these exact arguments: ${JSON.stringify({ path: args.path, edits: args.edits, encoding: args.encoding ?? "utf-8" })}`;

          return summary;
        }),
      errorMessage: "Approval required: File editing requires user confirmation.",
      execute: {
        toolName: "execute_edit_file",
        buildArgs: (args) => ({
          path: args.path,
          edits: args.edits,
          encoding: args.encoding,
        }),
      },
    },
    handler: (_args) =>
      Effect.succeed({ success: false, result: null, error: "Approval required" }),
  });
}

export function createExecuteEditFileTool(): Tool<
  FileSystem.FileSystem | FileSystemContextService
> {
  const editOperationSchema = z.discriminatedUnion("type", [
    z
      .object({
        type: z.literal("replace_lines"),
        startLine: z
          .number()
          .int()
          .positive()
          .describe("Starting line number (1-based, inclusive)"),
        endLine: z.number().int().positive().describe("Ending line number (1-based, inclusive)"),
        content: z.string().describe("New content to replace the specified lines"),
      })
      .refine((data) => data.startLine <= data.endLine, {
        message: "startLine must be less than or equal to endLine",
      }),
    z.object({
      type: z.literal("replace_pattern"),
      pattern: z
        .string()
        .min(1)
        .describe(
          "Pattern to find (literal string or 're:<regex>' for regex patterns, e.g., 're:function\\s+\\w+')",
        ),
      replacement: z.string().describe("Replacement text"),
      count: z
        .number()
        .int()
        .optional()
        .describe("Number of occurrences to replace (default: 1, use -1 for all occurrences)"),
    }),
    z.object({
      type: z.literal("insert"),
      line: z
        .number()
        .int()
        .nonnegative()
        .describe(
          "Line number to insert after (0 = before first line, 1 = after line 1, 2 = after line 2, etc.)",
        ),
      content: z.string().describe("Content to insert"),
    }),
    z
      .object({
        type: z.literal("delete_lines"),
        startLine: z
          .number()
          .int()
          .positive()
          .describe("Starting line number (1-based, inclusive)"),
        endLine: z.number().int().positive().describe("Ending line number (1-based, inclusive)"),
      })
      .refine((data) => data.startLine <= data.endLine, {
        message: "startLine must be less than or equal to endLine",
      }),
  ]);

  const parameters = z
    .object({
      path: z.string().min(1).describe("File path to edit (file must exist)"),
      edits: z.array(editOperationSchema).min(1).describe("Array of edit operations to perform"),
      encoding: z.string().optional().describe("Text encoding (default: utf-8)"),
    })
    .strict();

  return defineTool<FileSystem.FileSystem | FileSystemContextService, EditFileArgs>({
    name: "execute_edit_file",
    description:
      "Executes the actual file edit operation after user approval of edit_file. Applies multiple edit operations to a file in sequence. This tool is called after edit_file receives user approval.",
    hidden: true,
    parameters,
    validate: (args) => {
      const result = parameters.safeParse(args);
      return result.success
        ? ({ valid: true, value: result.data as unknown as EditFileArgs } as const)
        : ({ valid: false, errors: result.error.issues.map((i) => i.message) } as const);
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const shell = yield* FileSystemContextServiceTag;
        const target = yield* shell.resolvePath(buildKeyFromContext(context), args.path);

        const fileExists = yield* fs
          .exists(target)
          .pipe(Effect.catchAll(() => Effect.succeed(false)));

        if (!fileExists) {
          return {
            success: false,
            result: null,
            error: `File does not exist: ${target}. Cannot edit a file that doesn't exist.`,
          };
        }

        try {
          // Read the current file content
          const fileContent = yield* fs.readFileString(target);
          const lines = fileContent.split("\n");

          let currentLines = [...lines];
          const appliedEdits: string[] = [];

          // Apply each edit operation in sequence
          for (const edit of args.edits) {
            switch (edit.type) {
              case "replace_lines": {
                // Convert 1-based to 0-based
                const startIdx = edit.startLine - 1;
                const endIdx = edit.endLine - 1;

                if (startIdx < 0 || endIdx >= currentLines.length) {
                  throw new Error(
                    `Line range ${edit.startLine}-${edit.endLine} is out of bounds (file has ${currentLines.length} lines)`,
                  );
                }

                const newContentLines = edit.content.split("\n");
                currentLines = [
                  ...currentLines.slice(0, startIdx),
                  ...newContentLines,
                  ...currentLines.slice(endIdx + 1),
                ];
                appliedEdits.push(
                  `Replaced lines ${edit.startLine}-${edit.endLine} with ${newContentLines.length} line(s)`,
                );
                break;
              }

              case "replace_pattern": {
                const patternInfo = normalizeFilterPattern(edit.pattern);
                let content = currentLines.join("\n");
                let replacementCount = 0;
                const maxReplacements = edit.count === -1 ? Infinity : (edit.count ?? 1);

                if (patternInfo.type === "regex" && patternInfo.regex) {
                  // Regex replacement
                  const regex = patternInfo.regex;
                  let match;
                  const matches: Array<{ index: number; length: number }> = [];

                  // Find all matches first
                  while (
                    (match = regex.exec(content)) !== null &&
                    replacementCount < maxReplacements
                  ) {
                    matches.push({ index: match.index, length: match[0].length });
                    replacementCount++;
                    // Prevent infinite loop on zero-length matches
                    if (match.index === regex.lastIndex) {
                      regex.lastIndex++;
                    }
                  }

                  // Replace from end to start to preserve indices
                  for (let i = matches.length - 1; i >= 0; i--) {
                    const m = matches[i];
                    if (m) {
                      content =
                        content.slice(0, m.index) +
                        edit.replacement +
                        content.slice(m.index + m.length);
                    }
                  }
                } else {
                  // Literal string replacement
                  const searchStr = patternInfo.value || edit.pattern;
                  let searchIndex = 0;
                  while (
                    replacementCount < maxReplacements &&
                    (searchIndex = content.indexOf(searchStr, searchIndex)) !== -1
                  ) {
                    content =
                      content.slice(0, searchIndex) +
                      edit.replacement +
                      content.slice(searchIndex + searchStr.length);
                    replacementCount++;
                    searchIndex += edit.replacement.length;
                  }
                }

                currentLines = content.split("\n");
                appliedEdits.push(
                  `Replaced pattern "${edit.pattern}" ${replacementCount} time(s) with "${edit.replacement}"`,
                );
                break;
              }

              case "insert": {
                // Line number directly maps to insertion index (0 = before first line, 1 = after line 1, etc.)
                const insertIdx = edit.line;
                const newContentLines = edit.content.split("\n");

                if (insertIdx < 0 || insertIdx > currentLines.length) {
                  throw new Error(
                    `Insert position ${edit.line} is out of bounds (file has ${currentLines.length} lines)`,
                  );
                }

                currentLines = [
                  ...currentLines.slice(0, insertIdx),
                  ...newContentLines,
                  ...currentLines.slice(insertIdx),
                ];
                appliedEdits.push(
                  `Inserted ${newContentLines.length} line(s) after line ${edit.line}`,
                );
                break;
              }

              case "delete_lines": {
                // Convert 1-based to 0-based
                const startIdx = edit.startLine - 1;
                const endIdx = edit.endLine - 1;

                if (startIdx < 0 || endIdx >= currentLines.length) {
                  throw new Error(
                    `Line range ${edit.startLine}-${edit.endLine} is out of bounds (file has ${currentLines.length} lines)`,
                  );
                }

                const deletedCount = endIdx - startIdx + 1;
                currentLines = [
                  ...currentLines.slice(0, startIdx),
                  ...currentLines.slice(endIdx + 1),
                ];
                appliedEdits.push(
                  `Deleted lines ${edit.startLine}-${edit.endLine} (${deletedCount} line(s))`,
                );
                break;
              }
            }
          }

          // Write the modified content back
          const newContent = currentLines.join("\n");
          yield* fs.writeFileString(target, newContent);

          return {
            success: true,
            result: {
              path: target,
              editsApplied: appliedEdits,
              totalEdits: args.edits.length,
              originalLines: lines.length,
              newLines: currentLines.length,
            },
          };
        } catch (error) {
          return {
            success: false,
            result: null,
            error: `editFile failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }),
  });
}

// grep
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
        ? ({
            valid: true,
            value: params.data,
          } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
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

// find
export function createFindTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z.string().optional().describe("Start directory (defaults to smart search)"),
      name: z.string().optional().describe("Filter by name (substring or 're:<regex>')"),
      type: z.enum(["file", "dir", "all"]).optional().describe("Type filter"),
      maxDepth: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Maximum depth to traverse (0=current dir)"),
      maxResults: z.number().int().positive().optional().describe("Maximum results to return"),
      includeHidden: z.boolean().optional().describe("Include dotfiles and dot-directories"),
      smart: z
        .boolean()
        .optional()
        .describe("Use smart hierarchical search (HOME first, then expand)"),
    })
    .strict();

  type FindArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, FindArgs>({
    name: "find",
    description:
      "Advanced file and directory search with smart hierarchical search strategy (searches cwd, home, and parent directories in order). Supports deep traversal (default 25 levels), regex patterns, type filters, and hidden files. Use for comprehensive searches when find_path doesn't locate what you need.",
    tags: ["filesystem", "search"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({
            valid: true,
            value: params.data,
          } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;

        const includeHidden = args.includeHidden === true;
        const maxResults =
          typeof args.maxResults === "number" && args.maxResults > 0 ? args.maxResults : 5000;
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

        const allResults: { path: string; name: string; type: "file" | "dir" }[] = [];

        // Search each path in order using system find command
        for (const searchPath of searchPaths) {
          if (allResults.length >= maxResults) break;

          // Build find command arguments
          const findArgs: string[] = [searchPath];

          // Add max depth
          findArgs.push("-maxdepth", maxDepth.toString());

          // Add type filter
          if (typeFilter === "dir") {
            findArgs.push("-type", "d");
          } else if (typeFilter === "file") {
            findArgs.push("-type", "f");
          }

          // Add name pattern if specified
          if (args.name) {
            const filter = normalizeFilterPattern(args.name);
            if (filter.type === "regex" && filter.regex) {
              findArgs.push("-regex", filter.regex.source);
            } else if (filter.value) {
              findArgs.push("-iname", `*${filter.value}*`);
            }
          }

          // Handle hidden files
          if (!includeHidden) {
            findArgs.push("!", "-name", ".*");
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
                  cwd: searchPath,
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

          if (result.exitCode !== 0) {
            // Continue to next search path if this one fails
            continue;
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
                type: isDir ? ("dir" as const) : ("file" as const),
              };
            });

          allResults.push(...paths);

          // If we found results and using smart search, we can stop early
          // This prevents searching too many locations when we already have good results
          if (useSmart && allResults.length >= Math.min(maxResults / 2, 10)) {
            break;
          }
        }

        return {
          success: true,
          result: allResults.slice(0, maxResults),
        };
      }),
  });
}

// finddir - search for directories by name
export function createFindDirTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      name: z.string().min(1).describe("Directory name to search for (partial matches supported)"),
      path: z
        .string()
        .optional()
        .describe("Starting path for search (defaults to current working directory)"),
      maxDepth: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum search depth (default: 3)"),
    })
    .strict();

  type FindDirArgs = z.infer<typeof parameters>;
  return defineTool<FileSystem.FileSystem | FileSystemContextService, FindDirArgs>({
    name: "find_dir",
    description:
      "Search specifically for directories by name with partial matching support. Specialized version of find_path that only returns directories. Use when you need to locate a directory and want to filter out files from results.",
    tags: ["filesystem", "search"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({
            valid: true,
            value: params.data,
          } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const startPath = args.path
          ? yield* shell.resolvePath(buildKeyFromContext(context), args.path)
          : yield* shell.getCwd(buildKeyFromContext(context));

        const found = yield* shell.findDirectory(
          buildKeyFromContext(context),
          args.name,
          args.maxDepth || 3,
        );

        return {
          success: true,
          result: {
            searchTerm: args.name,
            startPath,
            found: found.results,
            count: found.results.length,
          },
        };
      }),
  });
}

// mkdir (approval required)
export function createMkdirTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z.string().min(1).describe("Directory path to create"),
      recursive: z.boolean().optional().describe("Create parent directories as needed"),
    })
    .strict();

  type MkdirArgs = z.infer<typeof parameters>;
  return defineTool<FileSystem.FileSystem | FileSystemContextService, MkdirArgs>({
    name: "mkdir",
    description: "Create a directory (requires user approval)",
    tags: ["filesystem", "write"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({
            valid: true,
            value: params.data,
          } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    approval: {
      message: (args, context) =>
        Effect.gen(function* () {
          const shell = yield* FileSystemContextServiceTag;
          const fs = yield* FileSystem.FileSystem;
          const target = yield* shell.resolvePathForMkdir(buildKeyFromContext(context), args.path);

          // Check if directory already exists
          const statResult = yield* fs
            .stat(target)
            .pipe(Effect.catchAll(() => Effect.succeed(null)));

          if (statResult) {
            if (statResult.type === "Directory") {
              return `Directory already exists: ${target}\n\nNo action needed - the directory is already present.`;
            } else {
              return `Path exists but is not a directory: ${target}\n\nCannot create directory at this location because a file already exists.`;
            }
          }

          return `About to create directory: ${target}${args.recursive === false ? "" : " (with parents)"}.\n\nIMPORTANT: After getting user confirmation, you MUST call the execute_mkdir tool with these exact arguments: {"path": "${args.path}", "recursive": ${args.recursive !== false}}`;
        }),
      errorMessage: "Approval required: Directory creation requires user confirmation.",
      execute: {
        toolName: "execute_mkdir",
        buildArgs: (args) => ({
          path: (args as { path: string; recursive?: boolean }).path,
          recursive: (args as { path: string; recursive?: boolean }).recursive,
        }),
      },
    },
    handler: (_args) =>
      Effect.succeed({ success: false, result: null, error: "Approval required" }),
  });
}

export function createExecuteMkdirTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z.string().min(1).describe("Directory path to create"),
      recursive: z.boolean().optional().describe("Create parent directories as needed"),
    })
    .strict();

  type ExecuteMkdirArgs = z.infer<typeof parameters>;
  return defineTool<FileSystem.FileSystem | FileSystemContextService, ExecuteMkdirArgs>({
    name: "execute_mkdir",
    description:
      "Executes the actual directory creation after user approval of mkdir. Creates the directory at the specified path, optionally creating parent directories. This tool is called after mkdir receives user approval.",
    hidden: true,
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({
            valid: true,
            value: params.data,
          } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const shell = yield* FileSystemContextServiceTag;
        const target = yield* shell.resolvePathForMkdir(buildKeyFromContext(context), args.path);

        // Check if directory already exists
        const statResult = yield* fs.stat(target).pipe(Effect.catchAll(() => Effect.succeed(null)));

        if (statResult) {
          if (statResult.type === "Directory") {
            return { success: true, result: `Directory already exists: ${target}` };
          } else {
            return {
              success: false,
              result: null,
              error: `Cannot create directory '${target}': a file already exists at this path`,
            };
          }
        }

        try {
          yield* fs.makeDirectory(target, { recursive: args.recursive !== false });
          return { success: true, result: `Directory created: ${target}` };
        } catch (error) {
          return {
            success: false,
            result: null,
            error: `mkdir failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }),
  });
}

// stat - check if file/directory exists and get info
export function createStatTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z.string().min(1).describe("File or directory path to check"),
    })
    .strict();

  type StatArgs = z.infer<typeof parameters>;
  return defineTool<FileSystem.FileSystem | FileSystemContextService, StatArgs>({
    name: "stat",
    description:
      "Check if a file or directory exists and retrieve its metadata (type, size, modification time, access time). Use this to verify existence before operations or to get file information without reading contents.",
    tags: ["filesystem", "info"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({
            valid: true,
            value: params.data,
          } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const shell = yield* FileSystemContextServiceTag;
        const target = yield* shell.resolvePathForMkdir(buildKeyFromContext(context), args.path);

        try {
          const stat = yield* fs.stat(target);
          const normalizedSize = normalizeStatSize((stat as { size: unknown }).size);
          return {
            success: true,
            result: {
              path: target,
              exists: true,
              type: stat.type,
              size: normalizedSize,
              mtime: stat.mtime,
              atime: stat.atime,
            },
          };
        } catch (error) {
          // Check if it's a "not found" error
          if (error instanceof Error) {
            const cause = (error as { cause?: { code?: string } }).cause;
            const code = typeof cause?.code === "string" ? cause.code : undefined;
            if (code?.includes("ENOENT")) {
              return {
                success: true,
                result: {
                  path: target,
                  exists: false,
                  type: null,
                  size: null,
                  mtime: null,
                  atime: null,
                },
              };
            }
          }

          return {
            success: false,
            result: null,
            error: `stat failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }),
  });
}

// rm (approval required)
export function createRmTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z.string().min(1).describe("File or directory to remove"),
      recursive: z.boolean().optional().describe("Recursively remove directories"),
      force: z.boolean().optional().describe("Ignore non-existent files and errors"),
    })
    .strict();

  type RmArgs = z.infer<typeof parameters>;
  return defineTool<FileSystem.FileSystem | FileSystemContextService, RmArgs>({
    name: "rm",
    description: "Remove a file or directory (requires user approval)",
    tags: ["filesystem", "destructive"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({
            valid: true,
            value: params.data,
          } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    approval: {
      message: (args, context) =>
        Effect.gen(function* () {
          const shell = yield* FileSystemContextServiceTag;
          const target = yield* shell.resolvePath(buildKeyFromContext(context), args.path);
          const recurse = args.recursive === true ? " recursively" : "";
          return `About to delete${recurse}: ${target}. This action may be irreversible.\n\nIMPORTANT: After getting user confirmation, you MUST call the execute_rm tool with the same arguments: {"path": "${args.path}", "recursive": ${args.recursive === true}, "force": ${args.force === true}}`;
        }),
      errorMessage: "Approval required: File/directory deletion requires user confirmation.",
      execute: {
        toolName: "execute_rm",
        buildArgs: (args) => ({
          path: (args as { path: string }).path,
          recursive: (args as { recursive?: boolean }).recursive,
          force: (args as { force?: boolean }).force,
        }),
      },
    },
    handler: (_args) =>
      Effect.succeed({ success: false, result: null, error: "Approval required" }),
  });
}

export function createExecuteRmTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z.string().min(1).describe("File or directory to remove"),
      recursive: z.boolean().optional().describe("Recursively remove directories"),
      force: z.boolean().optional().describe("Ignore non-existent files and errors"),
    })
    .strict();

  type ExecuteRmArgs = z.infer<typeof parameters>;
  return defineTool<FileSystem.FileSystem | FileSystemContextService, ExecuteRmArgs>({
    name: "execute_rm",
    description:
      "Executes the actual file/directory removal after user approval of rm. Deletes the specified path, optionally recursively for directories. This tool is called after rm receives user approval.",
    hidden: true,
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({
            valid: true,
            value: params.data,
          } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const shell = yield* FileSystemContextServiceTag;
        const target = yield* shell.resolvePath(buildKeyFromContext(context), args.path);
        try {
          // Basic safeguards: do not allow deleting root or home dir directly
          if (target === "/" || target === process.env["HOME"]) {
            return {
              success: false,
              result: null,
              error: `Refusing to remove critical path: ${target}`,
            };
          }
          // If not recursive and target is directory, error
          const st = yield* fs
            .stat(target)
            .pipe(
              Effect.catchAll((err) =>
                args.force ? Effect.fail(err as Error) : Effect.fail(err as Error),
              ),
            );
          if (st.type === "Directory" && args.recursive !== true) {
            return {
              success: false,
              result: null,
              error: `Path is a directory, use recursive: true`,
            };
          }
          yield* fs.remove(target, {
            recursive: args.recursive === true,
            force: args.force === true,
          });
          return { success: true, result: `Removed: ${target}` };
        } catch (error) {
          if (args.force) {
            return {
              success: true,
              result: `Removal attempted with force; error ignored: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
          return {
            success: false,
            result: null,
            error: `rm failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }),
  });
}
