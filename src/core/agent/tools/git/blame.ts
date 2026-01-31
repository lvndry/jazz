import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";
import { defineTool } from "../base-tool";
import { resolveGitWorkingDirectory, runGitCommand } from "./utils";

/**
 * Git blame tool - shows file annotations (who changed what line)
 */

export function createGitBlameTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z
        .string()
        .optional()
        .describe(
          "Path to a file or directory in the Git repository (defaults to current working directory)",
        ),
      file: z.string().min(1).describe("Path to the file to blame (relative to repository root)"),
      startLine: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Start line number (1-based, inclusive)"),
      endLine: z.number().int().min(1).optional().describe("End line number (1-based, inclusive)"),
      showEmail: z.boolean().optional().describe("Show author email instead of name"),
      showLineNumbers: z.boolean().optional().describe("Show line numbers in output"),
    })
    .strict();

  type GitBlameArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitBlameArgs>({
    name: "git_blame",
    description:
      "Show what revision and author last modified each line of a file. Displays commit hash, author, date, and line content for each line. Useful for tracking who changed what and when, debugging issues, or understanding code history. Supports line range filtering and various output formats.",
    tags: ["git", "blame", "history"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: (args: GitBlameArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const fs = yield* FileSystem.FileSystem;

        let workingDirError: string | null = null;
        const workingDir = yield* resolveGitWorkingDirectory(shell, context, fs, args?.path).pipe(
          Effect.catchAll((error) => {
            workingDirError = error instanceof Error ? error.message : String(error);
            return Effect.succeed(null);
          }),
        );

        if (workingDir === null) {
          return {
            success: false,
            result: null,
            error: workingDirError || "Failed to resolve working directory",
          };
        }

        const blameArgs: string[] = ["blame", "--no-color"];
        if (args?.showEmail) {
          blameArgs.push("--show-email");
        }
        if (args?.showLineNumbers) {
          blameArgs.push("--show-number");
        }

        // Add line range if specified
        if (args?.startLine && args?.endLine) {
          if (args.startLine > args.endLine) {
            return {
              success: false,
              result: null,
              error: `Invalid line range: start line (${args.startLine}) must be <= end line (${args.endLine})`,
            };
          }
          blameArgs.push(`-L${args.startLine},${args.endLine}`);
        } else if (args?.startLine) {
          blameArgs.push(`-L${args.startLine},${args.startLine}`);
        }

        blameArgs.push(args.file);

        let commandError: string | null = null;
        const commandResult = yield* runGitCommand({
          args: blameArgs,
          workingDirectory: workingDir,
          timeoutMs: 20_000,
        }).pipe(
          Effect.catchAll((error) => {
            const errorMsg = error instanceof Error ? error.message : String(error);
            commandError = `Failed to execute git blame in directory '${workingDir}': ${errorMsg}`;
            return Effect.succeed(null);
          }),
        );

        if (commandResult === null) {
          return {
            success: false,
            result: null,
            error: commandError || `Failed to execute git blame in directory '${workingDir}'`,
          };
        }

        if (commandResult.exitCode !== 0) {
          return {
            success: false,
            result: null,
            error:
              commandResult.stderr || `git blame failed with exit code ${commandResult.exitCode}`,
          };
        }

        const lines = commandResult.stdout
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => {
            // Parse blame output format: commit_hash (author date line_number) content
            const match = line.match(/^(\S+)\s+\(([^)]+)\s+(\d+)\)\s+(.*)$/);
            if (match && match.length >= 5) {
              const hash = match[1] || "unknown";
              const authorInfo = match[2] || "unknown";
              const lineNum = match[3] || "0";
              const content = match[4] || line;
              return {
                commitHash: hash,
                author: authorInfo.trim(),
                lineNumber: parseInt(lineNum, 10),
                content,
              };
            }
            // Fallback if parsing fails
            return {
              commitHash: "unknown",
              author: "unknown",
              lineNumber: 0,
              content: line,
            };
          });

        return {
          success: true,
          result: {
            workingDirectory: workingDir,
            file: args.file,
            lineCount: lines.length,
            lines,
            options: {
              startLine: args?.startLine,
              endLine: args?.endLine,
              showEmail: args?.showEmail ?? false,
              showLineNumbers: args?.showLineNumbers ?? false,
            },
          },
        };
      }),
    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as { file: string; lineCount: number };
        return `Blamed ${gitResult.lineCount} lines in ${gitResult.file}`;
      }
      return result.success ? "Git blame retrieved" : "Git blame failed";
    },
  });
}
