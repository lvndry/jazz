import { FileSystem } from "@effect/platform";
import { spawn } from "child_process";
import { Effect } from "effect";
import { z } from "zod";
import {
  type FileSystemContextService,
  FileSystemContextServiceTag,
} from "../../../services/shell";
import { defineTool } from "./base-tool";
import { buildKeyFromContext } from "./context-utils";
import { type Tool } from "./tool-registry";

/**
 * Filesystem and shell tools: pwd, ls, cd, grep, find, mkdir, rm
 * mkdir and rm require explicit approval and are executed via hidden execute* tools.
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

// find_path - helps agent discover paths when unsure
export function createFindPathTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      name: z.string().min(1).describe("Name or partial name of the directory/file to find"),
      maxDepth: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum search depth (default: 3)"),
      type: z.enum(["directory", "file", "both"]).optional().describe("Type of item to search for"),
      searchPath: z
        .string()
        .optional()
        .describe("Directory to start search from (defaults to current directory)"),
    })
    .strict();

  return defineTool<
    FileSystem.FileSystem | FileSystemContextService,
    { name: string; maxDepth?: number; type?: "directory" | "file" | "both"; searchPath?: string }
  >({
    name: "find_path",
    description: "Quick search for files or directories by name with shallow depth (default 3 levels). Use when you need to quickly locate a specific file or directory by name without deep traversal.",
    tags: ["filesystem", "search"],
    parameters,
    validate: (args) => {
      const result = parameters.safeParse(args);
      return result.success
        ? ({
            valid: true,
            value: result.data as unknown as {
              name: string;
              maxDepth?: number;
              type?: "directory" | "file" | "both";
              searchPath?: string;
            },
          } as const)
        : ({ valid: false, errors: result.error.issues.map((i) => i.message) } as const);
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;

        const currentDir = yield* shell.getCwd(buildKeyFromContext(context));
        const searchDir = args.searchPath
          ? yield* shell.resolvePath(buildKeyFromContext(context), args.searchPath)
          : currentDir;

        const maxDepth = args.maxDepth ?? 3;
        const searchType = args.type ?? "both";

        // Build find command arguments
        const findArgs: string[] = [searchDir];

        // Add max depth
        findArgs.push("-maxdepth", maxDepth.toString());

        // Add type filter
        if (searchType === "directory") {
          findArgs.push("-type", "d");
        } else if (searchType === "file") {
          findArgs.push("-type", "f");
        }

        // Add name pattern (case-insensitive)
        findArgs.push("-iname", `*${args.name}*`);

        const command = `find ${findArgs.map((arg) => shell.escapePath(arg)).join(" ")}`;

        // Execute the find command
        const result = yield* Effect.promise<{
          stdout: string;
          stderr: string;
          exitCode: number;
        }>(
          () =>
            new Promise((resolve, reject) => {
              const child = spawn("sh", ["-c", command], {
                stdio: ["ignore", "pipe", "pipe"],
                timeout: 30000,
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
            results: paths.slice(0, 50), // Limit results to avoid overwhelming output
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
      const result = parameters.safeParse(args);
      return result.success
        ? ({ valid: true, value: result.data as unknown as Record<string, never> } as const)
        : ({ valid: false, errors: result.error.issues.map((i) => i.message) } as const);
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
    description: "List files and directories within a specified path. Supports recursive traversal, filtering by name patterns (substring or regex), showing hidden files, and limiting results. Returns file/directory names, paths, and types.",
    tags: ["filesystem", "listing"],
    parameters,
    validate: (args) => {
      const result = parameters.safeParse(args);
      return result.success
        ? ({
            valid: true,
            value: result.data as unknown as {
              path?: string;
              showHidden?: boolean;
              recursive?: boolean;
              pattern?: string;
              maxResults?: number;
            },
          } as const)
        : ({ valid: false, errors: result.error.issues.map((i) => i.message) } as const);
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const shell = yield* FileSystemContextServiceTag;

        const basePath = args.path
          ? yield* shell.resolvePath(buildKeyFromContext(context), args.path).pipe(
              Effect.catchAll((error) =>
                Effect.succeed({
                  success: false,
                  result: null,
                  error: error instanceof Error ? error.message : String(error),
                }),
              ),
            )
          : yield* shell.getCwd(buildKeyFromContext(context));

        // If path resolution failed, return the error with suggestions
        if (typeof basePath === "object" && "success" in basePath && !basePath.success) {
          return basePath;
        }

        const resolvedPath = basePath as string;

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

        try {
          const stat = yield* fs.stat(resolvedPath);
          if (stat.type !== "Directory") {
            return { success: false, result: null, error: `Not a directory: ${resolvedPath}` };
          }
          yield* walk(resolvedPath);
          return { success: true, result: results };
        } catch (error) {
          return {
            success: false,
            result: null,
            error: `ls failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }),
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
      const result = parameters.safeParse(args);
      return result.success
        ? ({ valid: true, value: result.data as unknown as { path: string } } as const)
        : ({ valid: false, errors: result.error.issues.map((i) => i.message) } as const);
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const shell = yield* FileSystemContextServiceTag;

        // Try to resolve the path - this will provide helpful suggestions if the path doesn't exist
        const targetResult = yield* shell.resolvePath(buildKeyFromContext(context), args.path).pipe(
          Effect.catchAll((error) =>
            Effect.succeed({
              success: false,
              result: null,
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
        );

        // If path resolution failed, return the error with suggestions
        if (
          typeof targetResult === "object" &&
          "success" in targetResult &&
          !targetResult.success
        ) {
          return targetResult;
        }

        const target = targetResult as string;

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
    description: "Read the contents of a text file with optional line range selection (startLine/endLine). Automatically handles UTF-8 BOM, enforces size limits to prevent memory issues (default 128KB), and reports truncation. Returns file content, encoding, line counts, and range information.",
    tags: ["filesystem", "read"],
    parameters,
    validate: (args) => {
      const result = parameters.safeParse(args);
      return result.success
        ? ({
            valid: true,
            value: result.data as unknown as {
              path: string;
              startLine?: number;
              endLine?: number;
              maxBytes?: number;
              encoding?: string;
            },
          } as const)
        : ({ valid: false, errors: result.error.issues.map((i) => i.message) } as const);
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const shell = yield* FileSystemContextServiceTag;
        const filePathResult = yield* shell
          .resolvePath(buildKeyFromContext(context), args.path)
          .pipe(
            Effect.catchAll((error) =>
              Effect.succeed({
                success: false,
                result: null,
                error: error instanceof Error ? error.message : String(error),
              }),
            ),
          );

        // If path resolution failed, return the error with suggestions
        if (
          typeof filePathResult === "object" &&
          "success" in filePathResult &&
          !filePathResult.success
        ) {
          return filePathResult;
        }

        const filePath = filePathResult as string;

        try {
          const stat = yield* fs.stat(filePath);
          if (stat.type === "Directory") {
            return { success: false, result: null, error: `Not a file: ${filePath}` };
          }

          let content = yield* fs.readFileString(filePath);

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
              path: filePath,
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
      const result = parameters.safeParse(args);
      return result.success
        ? ({ valid: true, value: result.data as unknown as WriteFileArgs } as const)
        : ({ valid: false, errors: result.error.issues.map((i) => i.message) } as const);
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
    description: "Internal tool that performs the actual file write operation after user has approved the write_file request. Creates or overwrites the file at the specified path with the provided content.",
    hidden: true,
    parameters,
    validate: (args) => {
      const result = parameters.safeParse(args);
      return result.success
        ? ({ valid: true, value: result.data as unknown as WriteFileArgs } as const)
        : ({ valid: false, errors: result.error.issues.map((i) => i.message) } as const);
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const shell = yield* FileSystemContextServiceTag;
        const target = yield* shell.resolvePath(buildKeyFromContext(context), args.path, {
          skipExistenceCheck: true,
        });

        try {
          // Create parent directories if requested
          if (args.createDirs === true) {
            const parentDir = target.substring(0, target.lastIndexOf("/"));
            if (parentDir && parentDir !== target) {
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
        .describe("File pattern to search in (e.g., '*.js', '*.ts')"),
    })
    .strict();

  return defineTool<
    FileSystem.FileSystem | FileSystemContextService,
    {
      pattern: string;
      path?: string;
      recursive?: boolean;
      regex?: boolean;
      ignoreCase?: boolean;
      maxResults?: number;
      filePattern?: string;
    }
  >({
    name: "grep",
    description: "Search for text patterns within file contents using grep. Supports literal strings and regex patterns. Use to find specific code, text, or patterns across files. Returns matching lines with file paths and line numbers.",
    tags: ["search", "text"],
    parameters,
    validate: (args) => {
      const result = parameters.safeParse(args);
      return result.success
        ? ({
            valid: true,
            value: result.data as unknown as {
              pattern: string;
              path?: string;
              recursive?: boolean;
              regex?: boolean;
              ignoreCase?: boolean;
              maxResults?: number;
              filePattern?: string;
            },
          } as const)
        : ({ valid: false, errors: result.error.issues.map((i) => i.message) } as const);
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const start = args.path
          ? yield* shell.resolvePath(buildKeyFromContext(context), args.path)
          : yield* shell.getCwd(buildKeyFromContext(context));
        const recursive = args.recursive !== false;
        const maxResults =
          typeof args.maxResults === "number" && args.maxResults > 0 ? args.maxResults : 5000;

        // Build grep command arguments
        const grepArgs: string[] = [];

        // Add recursive flag
        if (recursive) {
          grepArgs.push("-r");
        }

        // Add case sensitivity
        if (args.ignoreCase) {
          grepArgs.push("-i");
        }

        // Add line numbers
        grepArgs.push("-n");

        // Add file pattern if specified
        if (args.filePattern) {
          grepArgs.push("--include", args.filePattern);
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
        grepArgs.push(searchPattern, start);

        const command = `grep ${grepArgs.map((arg) => shell.escapePath(arg)).join(" ")}`;

        // Execute the grep command
        const result = yield* Effect.promise<{
          stdout: string;
          stderr: string;
          exitCode: number;
        }>(
          () =>
            new Promise((resolve, reject) => {
              const child = spawn("sh", ["-c", command], {
                stdio: ["ignore", "pipe", "pipe"],
                timeout: 30000,
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
        const matches = result.stdout
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => {
            // Parse format: file:line:content
            const parts = line.split(":");
            if (parts.length >= 3 && parts[1]) {
              const file = parts[0];
              const lineNum = parseInt(parts[1], 10);
              const text = parts.slice(2).join(":");
              return {
                file,
                line: lineNum,
                text,
              };
            }
            return null;
          })
          .filter((match): match is { file: string; line: number; text: string } => match !== null);

        return {
          success: true,
          result: {
            pattern: args.pattern,
            searchPath: start,
            recursive,
            regex: args.regex === true || args.pattern.startsWith("re:"),
            ignoreCase: args.ignoreCase,
            filePattern: args.filePattern,
            matches: matches.slice(0, maxResults),
            totalFound: matches.length,
            message:
              matches.length === 0
                ? `No matches found for pattern "${args.pattern}"`
                : `Found ${matches.length} matches for pattern "${args.pattern}"`,
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

  return defineTool<
    FileSystem.FileSystem | FileSystemContextService,
    {
      path?: string;
      name?: string;
      type?: "file" | "dir" | "all";
      maxDepth?: number;
      maxResults?: number;
      includeHidden?: boolean;
      smart?: boolean;
    }
  >({
    name: "find",
    description:
      "Advanced file and directory search with smart hierarchical search strategy (searches cwd, home, and parent directories in order). Supports deep traversal (default 25 levels), regex patterns, type filters, and hidden files. Use for comprehensive searches when find_path doesn't locate what you need.",
    tags: ["filesystem", "search"],
    parameters,
    validate: (args) => {
      const result = parameters.safeParse(args);
      return result.success
        ? ({
            valid: true,
            value: result.data as unknown as {
              path?: string;
              name?: string;
              type?: "file" | "dir" | "all";
              maxDepth?: number;
              maxResults?: number;
              includeHidden?: boolean;
              smart?: boolean;
            },
          } as const)
        : ({ valid: false, errors: result.error.issues.map((i) => i.message) } as const);
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;

        const includeHidden = args.includeHidden === true;
        const maxResults =
          typeof args.maxResults === "number" && args.maxResults > 0 ? args.maxResults : 5000;
        const maxDepth = typeof args.maxDepth === "number" ? args.maxDepth : 25;
        const typeFilter = args.type ?? "all";
        const useSmart = args.smart !== false; // Default to true

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

          const command = `find ${findArgs.map((arg) => shell.escapePath(arg)).join(" ")}`;

          // Execute the find command
          const result = yield* Effect.promise<{
            stdout: string;
            stderr: string;
            exitCode: number;
          }>(
            () =>
              new Promise((resolve, reject) => {
                const child = spawn("sh", ["-c", command], {
                  stdio: ["ignore", "pipe", "pipe"],
                  timeout: 30000,
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

// mkdir (approval required)
export function createMkdirTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z.string().min(1).describe("Directory path to create"),
      recursive: z.boolean().optional().describe("Create parent directories as needed"),
    })
    .strict();

  return defineTool<
    FileSystem.FileSystem | FileSystemContextService,
    { path: string; recursive?: boolean }
  >({
    name: "mkdir",
    description: "Create a directory (requires user approval)",
    tags: ["filesystem", "write"],
    parameters,
    validate: (args) => {
      const result = parameters.safeParse(args);
      return result.success
        ? ({
            valid: true,
            value: result.data as unknown as { path: string; recursive?: boolean },
          } as const)
        : ({ valid: false, errors: result.error.issues.map((i) => i.message) } as const);
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

  return defineTool<
    FileSystem.FileSystem | FileSystemContextService,
    { path: string; recursive?: boolean }
  >({
    name: "execute_mkdir",
    description: "Internal tool that performs the actual directory creation after user has approved the mkdir request. Creates the directory at the specified path, optionally creating parent directories.",
    hidden: true,
    parameters,
    validate: (args) => {
      const result = parameters.safeParse(args);
      return result.success
        ? ({
            valid: true,
            value: result.data as unknown as { path: string; recursive?: boolean },
          } as const)
        : ({ valid: false, errors: result.error.issues.map((i) => i.message) } as const);
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

  return defineTool<FileSystem.FileSystem | FileSystemContextService, { path: string }>({
    name: "stat",
    description: "Check if a file or directory exists and retrieve its metadata (type, size, modification time, access time). Use this to verify existence before operations or to get file information without reading contents.",
    tags: ["filesystem", "info"],
    parameters,
    validate: (args) => {
      const result = parameters.safeParse(args);
      return result.success
        ? ({
            valid: true,
            value: result.data as unknown as { path: string; recursive?: boolean; force?: boolean },
          } as const)
        : ({ valid: false, errors: result.error.issues.map((i) => i.message) } as const);
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

  return defineTool<
    FileSystem.FileSystem | FileSystemContextService,
    { path: string; recursive?: boolean; force?: boolean }
  >({
    name: "rm",
    description: "Remove a file or directory (requires user approval)",
    tags: ["filesystem", "destructive"],
    parameters,
    validate: (args) => {
      const result = parameters.safeParse(args);
      return result.success
        ? ({
            valid: true,
            value: result.data as unknown as { path: string; recursive?: boolean; force?: boolean },
          } as const)
        : ({ valid: false, errors: result.error.issues.map((i) => i.message) } as const);
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

  return defineTool<
    FileSystem.FileSystem | FileSystemContextService,
    { path: string; recursive?: boolean; force?: boolean }
  >({
    name: "execute_rm",
    description: "Internal tool that performs the actual file/directory removal after user has approved the rm request. Deletes the specified path, optionally recursively for directories.",
    hidden: true,
    parameters,
    validate: (args) => {
      const result = parameters.safeParse(args);
      return result.success
        ? ({
            valid: true,
            value: result.data as unknown as { path: string; recursive?: boolean; force?: boolean },
          } as const)
        : ({ valid: false, errors: result.error.issues.map((i) => i.message) } as const);
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

  return defineTool<
    FileSystem.FileSystem | FileSystemContextService,
    { name: string; path?: string; maxDepth?: number }
  >({
    name: "find_dir",
    description: "Search specifically for directories by name with partial matching support. Specialized version of find_path that only returns directories. Use when you need to locate a directory and want to filter out files from results.",
    tags: ["filesystem", "search"],
    parameters,
    validate: (args) => {
      const result = parameters.safeParse(args);
      return result.success
        ? ({
            valid: true,
            value: result.data as unknown as { name: string; path?: string; maxDepth?: number },
          } as const)
        : ({ valid: false, errors: result.error.issues.map((i) => i.message) } as const);
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

// Registration helper
export function registerFileTools(): Effect.Effect<void, Error, FileSystem.FileSystem> {
  // This function is not used directly; register-tools.ts imports specific tools and registers them.
  return Effect.void;
}
