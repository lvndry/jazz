/**
 * `view_workspace` and `manage_workspace`: read and edit an agent's durable
 * scratch space, presented with the same line-numbered, view-a-range
 * ergonomics as the memory tools. Unlike memory (small, curated notes),
 * workspace is where large working drafts, research dumps, and intermediate
 * artifacts live — reference a workspace path from a memory entry once the
 * work is done, rather than duplicating it there.
 */

import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { WorkspaceService, WorkspaceViewOutcome } from "@/core/interfaces/workspace-service";
import { WorkspaceServiceTag } from "@/core/interfaces/workspace-service";
import type { ToolExecutionResult } from "@/core/types/tools";
import { defineTool, makeZodValidator } from "./base-tool";

type WorkspaceToolDeps = WorkspaceService | FileSystem.FileSystem;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function joinDisplayPath(base: string, name: string): string {
  return base === "/" ? `/${name}` : `${base}/${name}`;
}

function formatDirectoryOutcome(
  outcome: Extract<WorkspaceViewOutcome, { kind: "directory" }>,
): string {
  const header = `Here're the files and directories up to 2 levels deep in ${outcome.path}, excluding hidden items:`;
  if (outcome.entries.length === 0) {
    return `${header}\n(empty — nothing saved yet)`;
  }
  const lines = outcome.entries.map((entry) =>
    entry.kind === "directory"
      ? joinDisplayPath(outcome.path, entry.name)
      : `${joinDisplayPath(outcome.path, entry.name)}\t(${formatSize(entry.sizeBytes)})`,
  );
  return [header, ...lines].join("\n");
}

function formatFileOutcome(outcome: Extract<WorkspaceViewOutcome, { kind: "file" }>): string {
  const lines = outcome.content.length > 0 ? outcome.content.split("\n") : [""];
  const numbered = lines.map((line, index) => {
    const lineNumber = outcome.startLine + index;
    return `${String(lineNumber).padStart(6)}\t${line}`;
  });
  const truncationNote = outcome.truncated
    ? `\n[Content truncated. Re-view with a narrower view_range to see more.]`
    : "";
  return `Here's the content of ${outcome.path} with line numbers:\n${numbered.join("\n")}${truncationNote}`;
}

const viewWorkspaceParameters = z
  .object({
    path: z
      .string()
      .default("")
      .describe(
        'Path relative to this agent\'s workspace root (e.g. "research/notes.md" or ' +
          '"drafts/report.md"). Empty string or "/" views the root directory.',
      ),
    view_range: z
      .tuple([z.number().int(), z.number().int()])
      .optional()
      .describe(
        "Optional [start_line, end_line], 1-based. Use -1 as end_line for the end of the file. Ignored for directories.",
      ),
  })
  .strict();

type ViewWorkspaceArgs = z.infer<typeof viewWorkspaceParameters>;

export function createViewWorkspaceTool(): Tool<WorkspaceToolDeps> {
  return defineTool<WorkspaceToolDeps, ViewWorkspaceArgs>({
    name: "view_workspace",
    disclosure: "private",
    description:
      "View your durable scratch space: working drafts, research dumps, and intermediate " +
      "artifacts too large or too provisional for memory. No path lists everything you've " +
      "saved; a path reads one file. An empty or missing directory just means nothing has " +
      "been saved yet — that is a normal answer, not an error.",
    parameters: viewWorkspaceParameters,
    riskLevel: "read-only",
    hidden: false,
    validate: makeZodValidator(viewWorkspaceParameters),
    handler: (args, context) =>
      Effect.gen(function* () {
        const workspaceService = yield* WorkspaceServiceTag;
        const outcome = yield* workspaceService.view(context.agentId, args.path, args.view_range);

        if (outcome.kind === "not_found" || outcome.kind === "too_large") {
          return {
            success: false,
            result: null,
            error: outcome.message,
          } satisfies ToolExecutionResult;
        }

        const formatted =
          outcome.kind === "directory"
            ? formatDirectoryOutcome(outcome)
            : formatFileOutcome(outcome);

        return {
          success: true,
          result: { formatted, outcome },
        } satisfies ToolExecutionResult;
      }).pipe(
        Effect.catchAll((error) =>
          Effect.succeed({
            success: false,
            result: null,
            error: error instanceof Error ? error.message : String(error),
          } satisfies ToolExecutionResult),
        ),
      ),
    createSummary: (result) => {
      if (!result.success) return undefined;
      const data = result.result as { outcome: WorkspaceViewOutcome };
      if (data.outcome.kind === "directory")
        return `Listed workspace (${data.outcome.entries.length} item(s))`;
      if (data.outcome.kind === "file")
        return `Read workspace file (${data.outcome.totalLines} line(s))`;
      return undefined;
    },
  });
}

const manageWorkspaceParameters = z.discriminatedUnion("command", [
  z
    .object({
      command: z.literal("create"),
      path: z.string().min(1).describe("Workspace file path relative to the workspace directory."),
      file_text: z.string().describe("Full file contents. Errors if the path already exists."),
    })
    .strict(),
  z
    .object({
      command: z.literal("str_replace"),
      path: z.string().min(1).describe("Workspace file path relative to the workspace directory."),
      old_str: z.string().min(1).describe("Exact unique snippet to replace."),
      new_str: z.string().optional().describe("Replacement text. Omit to delete the snippet."),
    })
    .strict(),
  z
    .object({
      command: z.literal("insert"),
      path: z.string().min(1).describe("Workspace file path relative to the workspace directory."),
      insert_line: z
        .number()
        .int()
        .nonnegative()
        .describe(
          "0-based line index to insert after (0 = beginning of the file). Note that view_workspace view_range is 1-based.",
        ),
      insert_text: z.string().describe("Text to insert."),
    })
    .strict(),
  z
    .object({
      command: z.literal("delete"),
      path: z.string().min(1).describe("Workspace file path to delete."),
    })
    .strict(),
  z
    .object({
      command: z.literal("rename"),
      old_path: z.string().min(1).describe("Current path, relative to the workspace directory."),
      new_path: z.string().min(1).describe("New path, relative to the workspace directory."),
    })
    .strict(),
]);

type ManageWorkspaceArgs = z.infer<typeof manageWorkspaceParameters>;

export function createManageWorkspaceTool(): Tool<WorkspaceToolDeps> {
  return defineTool<WorkspaceToolDeps, ManageWorkspaceArgs>({
    name: "manage_workspace",
    disclosure: "private",
    description:
      "Save durable working drafts, research dumps, or intermediate artifacts that are too " +
      "large or too provisional for memory — full research results, scraped data, long " +
      "in-progress documents. Once work is done, reference the workspace path from a memory " +
      'entry (e.g. "full research at workspace/research/topic.md") instead of duplicating ' +
      "the content into memory. Never write secrets (account numbers, passwords, health data).",
    parameters: manageWorkspaceParameters,
    riskLevel: "low-risk",
    hidden: false,
    validate: makeZodValidator(manageWorkspaceParameters),
    handler: (args, context) =>
      Effect.gen(function* () {
        const workspaceService = yield* WorkspaceServiceTag;
        const agentId = context.agentId;

        const outcome = yield* (() => {
          switch (args.command) {
            case "create":
              return workspaceService.create(agentId, args.path, args.file_text);
            case "str_replace":
              return workspaceService.strReplace(agentId, args.path, args.old_str, args.new_str);
            case "insert":
              return workspaceService.insert(
                agentId,
                args.path,
                args.insert_line,
                args.insert_text,
              );
            case "delete":
              return workspaceService.delete(agentId, args.path);
            case "rename":
              return workspaceService.rename(agentId, args.old_path, args.new_path);
          }
        })();

        return {
          success: outcome.success,
          result: outcome.success ? { message: outcome.message } : null,
          ...(outcome.success ? {} : { error: outcome.message }),
        } satisfies ToolExecutionResult;
      }).pipe(
        Effect.catchAll((error) =>
          Effect.succeed({
            success: false,
            result: null,
            error: error instanceof Error ? error.message : String(error),
          } satisfies ToolExecutionResult),
        ),
      ),
    createSummary: (result) => {
      if (!result.success) return undefined;
      const data = result.result as { message: string };
      return data.message;
    },
  });
}
