/**
 * `view_memory` and `manage_memory`: read and edit an agent's persistent memory
 * files, presented with the line-numbered, view-a-range ergonomics of the
 * filesystem tools rather than raw content blobs.
 */

import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { MEMORY_EXTRACTOR_AGENT_ID } from "@/core/constants/memory";
import type { MemoryTrigger } from "@/core/interfaces/memory-provenance";
import type {
  MemoryService,
  MemoryViewOutcome,
  MemoryWriteContext,
} from "@/core/interfaces/memory-service";
import { MemoryServiceTag } from "@/core/interfaces/memory-service";
import type { Tool } from "@/core/interfaces/tool-registry";
import {
  MEMORY_ENTRY_KINDS,
  buildMemoryEntryPath,
  slugifyMemorySegment,
} from "@/core/memory/entry-path";
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
          'Empty string or "/" lists every scope you can access along with the files inside each one — ' +
          "use that to discover them instead of guessing.",
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
      "Consult memory when the request may depend on prior preferences, decisions, relationships, " +
      "or work from another conversation. Skip it when prior context cannot improve the answer. " +
      "Memory is split into scopes by subject; inspect only scopes relevant to the conversation. " +
      "Calling it with no path returns every memory scope you can access " +
      '(e.g. "personal", "github-project-a") and the files saved in each, with sizes, so one call tells you ' +
      "where relevant memory may live when the right scope is unclear. " +
      'A path like "personal/notes.md" then reads one file. ' +
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

const memoryTriggerParameter = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("misfire"),
      tool_name: z.string().min(1).describe("Tool whose call failed."),
      error_class: z
        .string()
        .min(1)
        .describe("Short, stable description of the failure, without paths, ids, or numbers."),
    }),
    z.object({
      kind: z.literal("correction"),
      corrected_behavior: z.string().min(1).describe("What the user said you should do instead."),
    }),
  ])
  .describe(
    "The failure this lesson prevents. Required for kind=lesson: a lesson whose failure is not " +
      "named can never be checked against what actually happens, so it would never be validated.",
  );

const createMemoryParameters = z.object({
  command: z.literal("create"),
  kind: z
    .enum(MEMORY_ENTRY_KINDS)
    .describe(
      'What this is. "preference" = how the user wants things done; "fact" = something stable ' +
        'about the user or their world; "lesson" = a failure and its fix, tied to something that ' +
        "actually went wrong.",
    ),
  subject: z
    .string()
    .min(1)
    .describe(
      'What the entry is about, in a few words (e.g. "rendered output opening"). Facts and ' +
        "preferences hold one entry per subject: reusing a subject is refused and you are shown " +
        "the existing entry to amend instead.",
    ),
  workflow: z
    .string()
    .optional()
    .describe(
      'The kind of work this applies to (e.g. "moodboard"), for preferences and lessons. Omit ' +
        "when it applies to every task. Workflows are not tied to a folder — the entry is " +
        "recalled wherever that kind of work happens.",
    ),
  scope: z
    .string()
    .optional()
    .describe("Memory scope to write into. Defaults to your first accessible scope."),
  trigger: memoryTriggerParameter.optional(),
  file_text: z
    .string()
    .describe("The entry itself. Keep it to one thought; the first line is used as its summary."),
});

/** Maps the tool's snake_case trigger shape onto the stored one. */
function toMemoryTrigger(trigger: z.infer<typeof memoryTriggerParameter>): MemoryTrigger {
  return trigger.kind === "misfire"
    ? { kind: "misfire", toolName: trigger.tool_name, errorClass: trigger.error_class }
    : { kind: "correction", correctedBehavior: trigger.corrected_behavior };
}

const manageMemoryCommands = z.discriminatedUnion("command", [
  createMemoryParameters,
  z.object({
    command: z.literal("str_replace"),
    path: z
      .string()
      .min(1)
      .describe('Memory file path, starting with a scope name (e.g. "personal/notes.md").'),
    old_str: z.string().min(1).describe("Exact unique snippet to replace."),
    new_str: z.string().optional().describe("Replacement text. Omit to delete the snippet."),
  }),
  z.object({
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
  }),
  z.object({
    command: z.literal("delete"),
    path: z
      .string()
      .min(1)
      .describe('Memory file path to delete, starting with a scope name (e.g. "personal/old.md").'),
  }),
  z.object({
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
  }),
]);

/**
 * A lesson must name the failure it prevents. The rule lives here rather than
 * on the create branch because a `superRefine` produces a ZodEffects, which a
 * discriminated union cannot hold as a member.
 */
const manageMemoryParameters = manageMemoryCommands.superRefine((value, ctx) => {
  if (value.command === "create" && value.kind === "lesson" && value.trigger === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["trigger"],
      message:
        "A lesson requires a trigger naming the failure it prevents, so it can be checked " +
        "against what actually happens later.",
    });
  }
});

type ManageMemoryArgs = z.infer<typeof manageMemoryParameters>;

export function createManageMemoryTool(): Tool<MemoryToolDeps> {
  return defineTool<MemoryToolDeps, ManageMemoryArgs>({
    name: "manage_memory",
    disclosure: "private",
    summary:
      "Remember durable user preferences, facts, corrections and lessons across conversations.",
    description:
      "Remember something durable about the user across conversations: a preference (how they want " +
      "things done), a fact (something stable about them or their world), or a lesson (a failure and " +
      "its fix, tied to something that actually went wrong). Not for bulk drafts or large artifacts " +
      "— those go in the scratchpad, referenced by path from a memory entry. Not for what the current " +
      "task is doing — that is work state. Do not save small talk, tentative thoughts, sensitive " +
      "personal data, or secrets.\n" +
      'Write facts, not commands: "user prefers concise replies" — not "always reply concisely", ' +
      "which a later session re-reads as an order overriding what the user is asking for then.\n" +
      "If an entry already covers the subject, amend it rather than adding a second one; facts and " +
      "preferences hold one entry per subject, and a create that reuses a subject is refused and " +
      "shows you the entry to edit.\n" +
      "create(kind, subject, file_text) stores a new entry and chooses its path for you; add " +
      'workflow to scope a preference or lesson to a kind of work (e.g. "moodboard"), omit it when ' +
      "it applies to every task — workflows are not tied to a folder, so the entry is recalled " +
      "wherever that work happens. A lesson also requires a trigger naming the failure it prevents. " +
      "str_replace(path, old_str, new_str) replaces one exact, unique snippet — omit new_str to " +
      "delete it; insert(path, insert_line, insert_text) inserts after a 0-based line; " +
      "delete(path) removes an entry; rename(old_path, new_path) moves one within its scope.",
    parameters: manageMemoryParameters,
    riskLevel: "low-risk",
    hidden: false,
    validate: makeZodValidator(manageMemoryParameters),
    handler: (args, context) =>
      Effect.gen(function* () {
        const memoryService = yield* MemoryServiceTag;
        const scopes = context.memoryScopes ?? [context.agentId];
        const writeContext: MemoryWriteContext = { agentId: context.agentId };

        const outcome = yield* (() => {
          switch (args.command) {
            case "create": {
              const scope = args.scope ?? scopes[0] ?? context.agentId;
              const targetPath = buildMemoryEntryPath({
                scope,
                kind: args.kind,
                subject: args.subject,
                ...(args.workflow !== undefined ? { workflow: args.workflow } : {}),
              });
              return memoryService.create(scopes, targetPath, args.file_text, {
                ...writeContext,
                entry: {
                  subject: slugifyMemorySegment(args.subject),
                  origin:
                    context.agentId === MEMORY_EXTRACTOR_AGENT_ID
                      ? ("auto" as const)
                      : ("user" as const),
                  ...(args.trigger !== undefined ? { trigger: toMemoryTrigger(args.trigger) } : {}),
                },
              });
            }
            case "str_replace":
              return memoryService.strReplace(
                scopes,
                args.path,
                args.old_str,
                args.new_str,
                writeContext,
              );
            case "insert":
              return memoryService.insert(
                scopes,
                args.path,
                args.insert_line,
                args.insert_text,
                writeContext,
              );
            case "delete":
              return memoryService.delete(scopes, args.path);
            case "rename":
              return memoryService.rename(scopes, args.old_path, args.new_path, writeContext);
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
