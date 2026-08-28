/**
 * `view_memory` and `manage_memory`: read and edit an agent's persistent memory
 * files, presented with the line-numbered, view-a-range ergonomics of the
 * filesystem tools rather than raw content blobs.
 */

import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import type { MemoryService, MemoryViewOutcome } from "@/core/interfaces/memory-service";
import { MemoryServiceTag } from "@/core/interfaces/memory-service";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { ToolExecutionResult } from "@/core/types/tools";
import { defineTool, makeZodValidator } from "./base-tool";

type MemoryToolDeps = MemoryService | FileSystem.FileSystem;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function joinDisplayPath(base: string, name: string): string {
  return base === "/" ? `/${name}` : `${base}/${name}`;
}

function formatDirectoryOutcome(
  outcome: Extract<MemoryViewOutcome, { kind: "directory" }>,
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

function formatFileOutcome(outcome: Extract<MemoryViewOutcome, { kind: "file" }>): string {
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

const viewMemoryParameters = z
  .object({
    path: z
      .string()
      .default("")
      .describe(
        'Path starting with a scope name (e.g. "personal/notes.txt" or "github-project-a/status.md"). ' +
          'Empty string or "/" lists the scopes you can access, each as a directory — use that to discover ' +
          "them instead of guessing.",
      ),
    view_range: z
      .tuple([z.number().int(), z.number().int()])
      .optional()
      .describe(
        "Optional [start_line, end_line], 1-based. Use -1 as end_line for the end of the file. Ignored for directories.",
      ),
  })
  .strict();

type ViewMemoryArgs = z.infer<typeof viewMemoryParameters>;

export function createViewMemoryTool(): Tool<MemoryToolDeps> {
  return defineTool<MemoryToolDeps, ViewMemoryArgs>({
    name: "view_memory",
    disclosure: "private",
    description:
      "Call this first, before you answer, at the start of every conversation — even a casual one. " +
      'No path lists the memory scopes you can access (e.g. "personal", "github-project-a"); ' +
      'a path like "personal/notes.md" reads one file within a scope. ' +
      "An empty or missing directory just means nothing has been saved yet — that is a normal answer, not an error.",
    parameters: viewMemoryParameters,
    riskLevel: "read-only",
    hidden: false,
    validate: makeZodValidator(viewMemoryParameters),
    handler: (args, context) =>
      Effect.gen(function* () {
        const memoryService = yield* MemoryServiceTag;
        const scopes = context.memoryScopes ?? [context.agentId];
        const outcome = yield* memoryService.view(scopes, args.path, args.view_range);

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
      const data = result.result as { outcome: MemoryViewOutcome };
      if (data.outcome.kind === "directory")
        return `Listed memory (${data.outcome.entries.length} item(s))`;
      if (data.outcome.kind === "file")
        return `Read memory file (${data.outcome.totalLines} line(s))`;
      return undefined;
    },
  });
}

const manageMemoryParameters = z.discriminatedUnion("command", [
  z
    .object({
      command: z.literal("create"),
      path: z
        .string()
        .min(1)
        .describe('Memory file path, starting with a scope name (e.g. "personal/notes.md").'),
      file_text: z.string().describe("Full file contents. Errors if the path already exists."),
    })
    .strict(),
  z
    .object({
      command: z.literal("str_replace"),
      path: z
        .string()
        .min(1)
        .describe('Memory file path, starting with a scope name (e.g. "personal/notes.md").'),
      old_str: z.string().min(1).describe("Exact unique snippet to replace."),
      new_str: z.string().optional().describe("Replacement text. Omit to delete the snippet."),
    })
    .strict(),
  z
    .object({
      command: z.literal("insert"),
      path: z
        .string()
        .min(1)
        .describe('Memory file path, starting with a scope name (e.g. "personal/notes.md").'),
      insert_line: z
        .number()
        .int()
        .nonnegative()
        .describe(
          "0-based line index to insert after (0 = beginning of the file). Note that view_memory view_range is 1-based.",
        ),
      insert_text: z.string().describe("Text to insert."),
    })
    .strict(),
  z
    .object({
      command: z.literal("delete"),
      path: z
        .string()
        .min(1)
        .describe(
          'Memory file path to delete, starting with a scope name (e.g. "personal/old.md").',
        ),
    })
    .strict(),
  z
    .object({
      command: z.literal("rename"),
      old_path: z
        .string()
        .min(1)
        .describe('Current path, starting with a scope name (e.g. "personal/notes.md").'),
      new_path: z
        .string()
        .min(1)
        .describe(
          "New path. Must start with the same scope name as old_path — moving a file between scopes isn't supported.",
        ),
    })
    .strict(),
]);

type ManageMemoryArgs = z.infer<typeof manageMemoryParameters>;

export function createManageMemoryTool(): Tool<MemoryToolDeps> {
  return defineTool<MemoryToolDeps, ManageMemoryArgs>({
    name: "manage_memory",
    disclosure: "private",
    description:
      "Save facts that will still matter later — preferences, location, age, how they like to work, project-specific notes. Write as soon as you learn it. " +
      'Every path starts with a scope name (e.g. "personal/preferences.md", "github-project-a/status.md") — call view_memory with no path to see which scopes you can access. ' +
      "Update an existing file instead of creating a new one for the same topic — call view_memory first. One file per topic within a scope, not a running log. " +
      "Rewrite anything that is no longer true. Never write small talk, this-task details, or secrets (account numbers, passwords, health data). " +
      "Commands: create(path, file_text) makes a new file, errors if it already exists; " +
      "str_replace(path, old_str, new_str) replaces one exact, unique snippet — omit new_str to delete it; " +
      "insert(path, insert_line, insert_text) inserts text after a 0-based line (0 = start of file); " +
      "delete(path) removes a file; rename(old_path, new_path) renames a file within its scope.",
    parameters: manageMemoryParameters,
    riskLevel: "low-risk",
    hidden: false,
    validate: makeZodValidator(manageMemoryParameters),
    handler: (args, context) =>
      Effect.gen(function* () {
        const memoryService = yield* MemoryServiceTag;
        const scopes = context.memoryScopes ?? [context.agentId];

        const outcome = yield* (() => {
          switch (args.command) {
            case "create":
              return memoryService.create(scopes, args.path, args.file_text);
            case "str_replace":
              return memoryService.strReplace(scopes, args.path, args.old_str, args.new_str);
            case "insert":
              return memoryService.insert(scopes, args.path, args.insert_line, args.insert_text);
            case "delete":
              return memoryService.delete(scopes, args.path);
            case "rename":
              return memoryService.rename(scopes, args.old_path, args.new_path);
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
