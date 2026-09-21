/**
 * `view_memory` and `manage_memory`: read and edit an agent's persistent memory
 * files, presented with the line-numbered, view-a-range ergonomics of the
 * filesystem tools rather than raw content blobs.
 */

import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { DEFAULT_MEMORY_SCOPE, MEMORY_EXTRACTOR_AGENT_ID } from "@/core/constants/memory";
import type { MemoryFailureSignature } from "@/core/interfaces/memory-provenance";
import type {
  MemoryService,
  MemoryViewOutcome,
  MemoryWriteContext,
} from "@/core/interfaces/memory-service";
import { MemoryServiceTag } from "@/core/interfaces/memory-service";
import type { Tool } from "@/core/interfaces/tool-registry";
import {
  buildMemoryEntryPath,
  describeUnusableSubject,
  describeUnusableTopic,
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
      "Check memory BEFORE answering or acting on any request that could be shaped by the user's " +
      "preferences, opinions, style, history, relationships, prior decisions, or past work. This " +
      "applies to tasks ('let's write a blog' → check for writing preferences) just as much as " +
      "questions ('what's my favorite X' → check for stored facts). Skip it only for requests " +
      "with no personal dimension (factual lookups, technical questions, time/weather). " +
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

const memoryFailureParameter = z
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
  .describe("The failure this lesson prevents. Required for lessons.");

const createMemoryParameters = z.object({
  command: z.literal("create"),
  subject: z
    .string()
    .min(1)
    .describe(
      'What this is about, in a few words (e.g. "rendered output opening"). One entry per ' +
        "subject: reusing one is refused and you are shown the existing entry to amend.",
    ),
  topic: z
    .string()
    .optional()
    .describe(
      'The kind of work this applies to (e.g. "moodboard"). Omit when it applies to every task. ' +
        "A topic is not a folder — the entry comes back wherever that work happens.",
    ),
  scope: z
    .string()
    .optional()
    .describe("Memory scope to write into. Defaults to your first accessible scope."),
  failure: memoryFailureParameter.optional(),
  file_text: z
    .string()
    .describe("The entry itself. Keep it to one thought; the first line is the point."),
});

/** Maps the tool's snake_case failure shape onto the stored one. */
function toMemoryFailureSignature(
  failure: z.infer<typeof memoryFailureParameter>,
): MemoryFailureSignature {
  return failure.kind === "misfire"
    ? { kind: "misfire", toolName: failure.tool_name, errorClass: failure.error_class }
    : { kind: "correction", correctedBehavior: failure.corrected_behavior };
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
const manageMemoryParameters = manageMemoryCommands;

type ManageMemoryArgs = z.infer<typeof manageMemoryParameters>;

export function createManageMemoryTool(): Tool<MemoryToolDeps> {
  return defineTool<MemoryToolDeps, ManageMemoryArgs>({
    name: "manage_memory",
    disclosure: "private",
    summary: "Remember durable user preferences, facts and corrections across conversations.",
    description:
      "Remember something durable about the user — how they want things done, something stable " +
      "about them, or a correction they gave you. No secrets.\n" +
      'Write facts, not commands: "prefers concise replies", not "always reply concisely" — a ' +
      "later session re-reads a command as an order.\n" +
      "One entry per subject: reusing one is refused and shows you the entry to amend.\n" +
      "create(subject, file_text) picks the path. Add topic to scope it to a kind of work, " +
      "which brings it back wherever that work happens rather than per folder; omit it when it " +
      "always applies. str_replace / insert / delete / rename take an entry's path.",
    parameters: manageMemoryParameters,
    riskLevel: "low-risk",
    hidden: false,
    validate: makeZodValidator(manageMemoryParameters),
    handler: (args, context) =>
      Effect.gen(function* () {
        const memoryService = yield* MemoryServiceTag;
        const scopes = context.memoryScopes ?? [DEFAULT_MEMORY_SCOPE];
        const writeContext: MemoryWriteContext = { agentId: context.agentId };

        const outcome = yield* (() => {
          switch (args.command) {
            case "create": {
              const unusable = describeUnusableSubject(args.subject);
              if (unusable !== undefined) {
                return Effect.succeed({ success: false, message: unusable });
              }
              if (args.topic !== undefined) {
                const unusableTopic = describeUnusableTopic(args.topic);
                if (unusableTopic !== undefined) {
                  return Effect.succeed({ success: false, message: unusableTopic });
                }
              }
              const scope = args.scope ?? scopes[0] ?? DEFAULT_MEMORY_SCOPE;
              const targetPath = buildMemoryEntryPath({
                scope,
                subject: args.subject,
                ...(args.topic !== undefined ? { topic: args.topic } : {}),
              });
              return memoryService.create(scopes, targetPath, args.file_text, {
                ...writeContext,
                entry: {
                  origin:
                    context.agentId === MEMORY_EXTRACTOR_AGENT_ID
                      ? ("auto" as const)
                      : ("user" as const),
                  ...(args.failure !== undefined
                    ? { failure: toMemoryFailureSignature(args.failure) }
                    : {}),
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
