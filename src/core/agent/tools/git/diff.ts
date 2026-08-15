import { Effect } from "effect";
import { z } from "zod";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";
import { defineTool, makeZodValidator } from "../base-tool";
import { spawnOutputTruncationNotice } from "../capped-output";
import {
  GIT_TIMEOUTS,
  gitRepoPathSchema,
  resolveGitRepoDir,
  runGitOrFail,
  withGitTruncation,
  type GitToolDeps,
} from "./utils";

/**
 * Git diff tool - shows differences between commits, branches, or working tree
 */

export function createGitDiffTool(): Tool<GitToolDeps> {
  const parameters = z
    .object({
      path: gitRepoPathSchema,
      staged: z.boolean().optional().describe("Show staged changes"),
      branch: z.string().optional().describe("Compare with branch"),
      commit: z.string().optional().describe("Compare with commit"),
      paths: z
        .array(z.string())
        .optional()
        .describe(
          "Scope diff to specific files (e.g. ['src/foo.ts', 'docs/bar.md']). Omit for full repo diff.",
        ),
      nameOnly: z
        .boolean()
        .optional()
        .describe("If true, return only the list of changed file paths (git diff --name-only)."),
      maxLines: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Cap on diff lines. Omit to return the whole diff (the default); set to bound output.",
        ),
    })
    .strict();

  type GitDiffArgs = z.infer<typeof parameters>;

  return defineTool<GitToolDeps, GitDiffArgs>({
    name: "git_diff",
    description:
      "Show differences between commits, branches, or working tree. Returns the whole diff by default; maxLines caps it.",
    tags: ["git", "diff"],
    parameters,
    validate: makeZodValidator(parameters),
    handler: (args: GitDiffArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const resolved = yield* resolveGitRepoDir(args?.path, context);
        if (resolved.kind === "failure") return resolved.result;
        const workingDir = resolved.path;

        const diffArgs: string[] = ["diff", "--no-color"];
        if (args?.nameOnly) {
          diffArgs.push("--name-only");
        }
        if (args?.staged) {
          diffArgs.push("--staged");
        }
        if (args?.branch) {
          diffArgs.push(args.branch);
        } else if (args?.commit) {
          diffArgs.push(args.commit);
        }
        if (args?.paths && args.paths.length > 0) {
          diffArgs.push("--", ...args.paths);
        }

        const executed = yield* runGitOrFail("git diff", {
          args: diffArgs,
          workingDirectory: workingDir,
          timeoutMs: GIT_TIMEOUTS.diff,
        });
        if (executed.kind === "failure") return executed.result;

        const gitResult = executed.result;

        const trimmedOutput = gitResult.stdout.trimEnd();

        if (args?.nameOnly) {
          const paths = trimmedOutput ? trimmedOutput.split("\n").filter((p) => p.length > 0) : [];
          return {
            success: true,
            result: withGitTruncation(
              {
                workingDirectory: workingDir,
                paths,
                nameOnly: true,
                count: paths.length,
              },
              gitResult,
            ),
          };
        }

        const hasChanges = trimmedOutput.length > 0;
        // Default is the WHOLE diff: an unspecified call returns everything, so
        // an agent never silently reviews a partial diff. maxLines is an opt-in
        // cap for callers that deliberately want a bounded slice.
        const maxLines = args.maxLines;
        let diff = trimmedOutput;
        let truncated = gitResult.stdoutTruncated;
        let totalLines = 0;
        let returnedLines = 0;

        if (hasChanges) {
          const lines = trimmedOutput.split("\n");
          totalLines = lines.length;
          if (maxLines !== undefined && lines.length > maxLines) {
            diff = lines.slice(0, maxLines).join("\n");
            truncated = true;
            returnedLines = maxLines;
          } else {
            returnedLines = lines.length;
          }
        }

        if (gitResult.stdoutTruncated) {
          diff = `${diff}\n${spawnOutputTruncationNotice("stdout")}`;
        }

        return {
          success: true,
          result: {
            workingDirectory: workingDir,
            paths: args?.paths ?? null,
            diff: diff || "No differences",
            hasChanges,
            truncated,
            totalLines,
            returnedLines,
            options: {
              staged: args.staged ?? false,
              branch: args.branch,
              commit: args.commit,
              paths: args?.paths ?? undefined,
              maxLines,
            },
          },
        };
      }),
    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as { hasChanges: boolean };
        return gitResult.hasChanges ? "Repository has differences" : "No differences found";
      }
      return result.success ? "Git diff retrieved" : "Git diff failed";
    },
  });
}
