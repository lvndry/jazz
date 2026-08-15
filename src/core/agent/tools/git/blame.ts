import { Effect } from "effect";
import { z } from "zod";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";
import { defineTool, makeZodValidator } from "../base-tool";
import {
  GIT_TIMEOUTS,
  gitRepoPathSchema,
  resolveGitRepoDir,
  runGitOrFail,
  withGitTruncation,
  type GitToolDeps,
} from "./utils";

/**
 * Git blame tool - shows file annotations (who changed what line)
 */

export function createGitBlameTool(): Tool<GitToolDeps> {
  const parameters = z
    .object({
      path: gitRepoPathSchema,
      file: z.string().min(1).describe("File path to blame"),
      startLine: z.number().int().min(1).optional().describe("Start line (1-based)"),
      endLine: z.number().int().min(1).optional().describe("End line (1-based)"),
      showEmail: z.boolean().optional().describe("Show email instead of name"),
      showLineNumbers: z.boolean().optional().describe("Show line numbers"),
    })
    .strict();

  type GitBlameArgs = z.infer<typeof parameters>;

  return defineTool<GitToolDeps, GitBlameArgs>({
    name: "git_blame",
    description: "Show revision and author for each line of a file. Supports line ranges.",
    tags: ["git", "blame", "history"],
    parameters,
    validate: makeZodValidator(parameters),
    handler: (args: GitBlameArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const resolved = yield* resolveGitRepoDir(args?.path, context);
        if (resolved.kind === "failure") return resolved.result;
        const workingDir = resolved.path;

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

        const executed = yield* runGitOrFail("git blame", {
          args: blameArgs,
          workingDirectory: workingDir,
          timeoutMs: GIT_TIMEOUTS.diff,
        });
        if (executed.kind === "failure") return executed.result;

        const commandResult = executed.result;

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
          result: withGitTruncation(
            {
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
            commandResult,
          ),
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
