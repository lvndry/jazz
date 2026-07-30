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
        'Path relative to this agent\'s memory root (e.g. "notes.txt" or "people/alex.md"). ' +
          'Empty string or "/" views the root directory.',
      ),
    view_range: z
      .tuple([z.number().int(), z.number().int()])
      .optional()
      .describe(
        "Optional [start_line, end_line], 1-indexed. Use -1 as end_line for end of file. Ignored for directories.",
      ),
  })
  .strict();

type ViewMemoryArgs = z.infer<typeof viewMemoryParameters>;

export function createViewMemoryTool(): Tool<MemoryToolDeps> {
  return defineTool<MemoryToolDeps, ViewMemoryArgs>({
    name: "view_memory",
    description:
      "Read what you've saved about this person or project from earlier conversations. " +
      "Call it with no path to list everything you've stored; call it with a path " +
      '(e.g. "people/alex.md" or "project-context.md") to read one file\'s full contents. ' +
      "Call this once, early, whenever you're not certain this is the first time you've talked " +
      "with this person — before assuming a clean slate. An empty or missing directory just means " +
      "nothing has been saved yet; that is a normal answer, not an error.",
    parameters: viewMemoryParameters,
    riskLevel: "read-only",
    hidden: false,
    validate: makeZodValidator(viewMemoryParameters),
    handler: (args, context) =>
      Effect.gen(function* () {
        const memoryService = yield* MemoryServiceTag;
        const outcome = yield* memoryService.view(context.agentId, args.path, args.view_range);

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
      path: z.string().min(1),
      file_text: z.string(),
    })
    .strict(),
  z
    .object({
      command: z.literal("str_replace"),
      path: z.string().min(1),
      old_str: z.string().min(1),
      new_str: z.string().optional(),
    })
    .strict(),
  z
    .object({
      command: z.literal("insert"),
      path: z.string().min(1),
      insert_line: z.number().int().nonnegative(),
      insert_text: z.string(),
    })
    .strict(),
  z
    .object({
      command: z.literal("delete"),
      path: z.string().min(1),
    })
    .strict(),
  z
    .object({
      command: z.literal("rename"),
      old_path: z.string().min(1),
      new_path: z.string().min(1),
    })
    .strict(),
]);

type ManageMemoryArgs = z.infer<typeof manageMemoryParameters>;

export function createManageMemoryTool(): Tool<MemoryToolDeps> {
  return defineTool<MemoryToolDeps, ManageMemoryArgs>({
    name: "manage_memory",
    description:
      "Create, edit, rename, or delete files under your persistent memory directory — the durable " +
      "notes about this person or project that survive after this conversation ends. Takes a " +
      '"command": "create" (path, file_text) writes a new file (errors if the path already exists — ' +
      'use str_replace or insert to update it instead); "str_replace" (path, old_str, new_str) replaces ' +
      "one exact, unique snippet in place — use this to correct or update a fact instead of appending a " +
      'new note about it; "insert" (path, insert_line, insert_text) adds a line at a specific position; ' +
      '"delete" (path) removes a file entirely; "rename" (old_path, new_path) moves or renames one. ' +
      "Prefer updating an existing file over creating a new one for the same topic — call view_memory " +
      "first to check what's already there. Keep the directory small and organized: one file per person " +
      "or per project, not a running log. Delete or rewrite a file the moment its contents are " +
      "contradicted or no longer true; stale memory is worse than no memory. Never write transient " +
      "conversation content, task-specific details, or anything guessable from context — only facts " +
      "and preferences durable enough to matter three conversations from now.",
    parameters: manageMemoryParameters,
    riskLevel: "low-risk",
    hidden: false,
    validate: makeZodValidator(manageMemoryParameters),
    handler: (args, context) =>
      Effect.gen(function* () {
        const memoryService = yield* MemoryServiceTag;
        const agentId = context.agentId;

        const outcome = yield* (() => {
          switch (args.command) {
            case "create":
              return memoryService.create(agentId, args.path, args.file_text);
            case "str_replace":
              return memoryService.strReplace(agentId, args.path, args.old_str, args.new_str);
            case "insert":
              return memoryService.insert(agentId, args.path, args.insert_line, args.insert_text);
            case "delete":
              return memoryService.delete(agentId, args.path);
            case "rename":
              return memoryService.rename(agentId, args.old_path, args.new_path);
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
