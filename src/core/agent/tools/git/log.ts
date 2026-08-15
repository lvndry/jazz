import { Effect } from "effect";
import { z } from "zod";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";
import { defineTool, makeZodValidator } from "../base-tool";
import {
  gitRepoPathSchema,
  resolveGitRepoDir,
  runGitOrFail,
  withGitTruncation,
  type GitToolDeps,
} from "./utils";

/**
 * Git log tool - displays commit history
 */

export function createGitLogTool(): Tool<GitToolDeps> {
  const parameters = z
    .object({
      path: gitRepoPathSchema,
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Max commits (default: 20, cap: 50)"),
      oneline: z.boolean().optional().describe("One-line format"),
    })
    .strict();

  type GitLogArgs = z.infer<typeof parameters>;

  return defineTool<GitToolDeps, GitLogArgs>({
    name: "git_log",
    description: "Show commit history. Default 20 commits, cap 50.",
    tags: ["git", "history"],
    parameters,
    validate: makeZodValidator(parameters),
    handler: (args: GitLogArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const resolved = yield* resolveGitRepoDir(args?.path, context);
        if (resolved.kind === "failure") return resolved.result;
        const workingDir = resolved.path;

        const requestedLimit = args?.limit ?? 20;
        const limit = Math.min(requestedLimit, 50);
        const prettyFormat = "%H%x1f%h%x1f%an%x1f%ar%x1f%s%x1e";

        const executed = yield* runGitOrFail("git log", {
          args: [
            "log",
            `--max-count=${limit}`,
            `--pretty=format:${prettyFormat}`,
            "--date=relative",
          ],
          workingDirectory: workingDir,
        });
        if (executed.kind === "failure") return executed.result;

        const gitResult = executed.result;

        const commits = gitResult.stdout
          .split("\x1e")
          .filter((entry) => entry.trim().length > 0)
          .map((entry) => {
            const [hash, shortHash, author, relativeDate, subject] = entry
              .split("\x1f")
              .map((value) => value.trim());
            return {
              hash,
              shortHash,
              author,
              relativeDate,
              subject,
              oneline: args?.oneline ? `${shortHash} ${subject}` : undefined,
            };
          });

        return {
          success: true,
          result: withGitTruncation(
            {
              workingDirectory: workingDir,
              commitCount: commits.length,
              commits,
            },
            gitResult,
          ),
        };
      }),
    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as { commitCount: number };
        return `Retrieved ${gitResult.commitCount} commits from Git history`;
      }
      return result.success ? "Git log retrieved" : "Git log failed";
    },
  });
}
