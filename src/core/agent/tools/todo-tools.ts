import * as nodeFs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import { z } from "zod";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { ToolExecutionResult } from "@/core/types/tools";
import { defineTool, makeZodValidator } from "./base-tool";

/**
 * Todo item schema — matches the shape persisted to the temp file.
 *
 * Progress and evidence are kept on separate fields on purpose. `status` answers how far
 * along the work is; `verifiedBy` answers whether anyone checked. Folding the second into
 * the first — a `unverified` status sitting between in_progress and completed — reads as a
 * progress state without being one, and every consumer then has to decide for itself
 * whether it counts as finished.
 *
 * `verifiedBy` is the part carried over from work state, which used to keep a rival list
 * of the same work. Its good idea was refusing to let an agent call something done on the
 * strength of having written it.
 */
const TodoItemSchema = z.object({
  content: z.string().describe("What this step is."),
  status: z
    .enum(["pending", "in_progress", "completed", "cancelled"])
    .describe("pending, in_progress, completed, or cancelled."),
  verifiedBy: z
    .string()
    .optional()
    .describe(
      'What you ran that confirms this works, e.g. "bun test src/foo.test.ts". Set it ' +
        "whenever you mark something completed. Leave it out if you believe the work is " +
        "finished but have not actually checked — completed without it reads as exactly " +
        "that, which is honest and useful; a claim you did not verify is not.",
    ),
  priority: z.enum(["high", "medium", "low"]).describe("high, medium, or low.").default("medium"),
});

type TodoItem = z.infer<typeof TodoItemSchema>;

// ---------------------------------------------------------------------------
// Temp-file helpers (Effect-based, async)
// ---------------------------------------------------------------------------

/**
 * Todos belong to a conversation, not to a terminal sitting.
 *
 * They used to be keyed by a per-sitting id that `/new` did not change, so starting a new
 * conversation silently inherited the previous one's list.
 */
function getTodoFilePath(conversationId: string): string {
  return path.join(os.tmpdir(), `jazz-todos-${conversationId}.json`);
}

function readTodos(conversationId: string): Effect.Effect<TodoItem[], Error> {
  const filePath = getTodoFilePath(conversationId);
  return Effect.tryPromise({
    try: () => nodeFs.readFile(filePath, "utf-8"),
    catch: () => new Error(`Failed to read todo file: ${filePath}`),
  }).pipe(
    Effect.flatMap((raw) =>
      Effect.try({
        try: () => {
          const parsed: unknown = JSON.parse(raw);
          return Array.isArray(parsed) ? (parsed as TodoItem[]) : [];
        },
        catch: () => new Error(`Corrupted todo file: ${filePath}`),
      }),
    ),
    // File not found or unreadable → empty list (not an error)
    Effect.catchAll(() => Effect.succeed([] as TodoItem[])),
  );
}

function writeTodos(conversationId: string, todos: TodoItem[]): Effect.Effect<void, Error> {
  const filePath = getTodoFilePath(conversationId);
  return Effect.tryPromise({
    try: () => nodeFs.writeFile(filePath, JSON.stringify(todos, null, 2), "utf-8"),
    catch: (error) =>
      new Error(
        `Failed to write todo file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      ),
  });
}

// ---------------------------------------------------------------------------
// Stat helpers
// ---------------------------------------------------------------------------

function computeStats(todos: TodoItem[]) {
  return {
    totalItems: todos.length,
    pending: todos.filter((t) => t.status === "pending").length,
    inProgress: todos.filter((t) => t.status === "in_progress").length,
    completed: todos.filter((t) => t.status === "completed").length,
    cancelled: todos.filter((t) => t.status === "cancelled").length,
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * `manage_todos` — overwrites the entire todo list with the provided array.
 *
 * The LLM sends the full, up-to-date list every time (including status changes).
 * This avoids partial-update ambiguity and keeps the state trivially mergeable.
 */
export function createManageTodosTool(): Tool<never> {
  const parameters = z.object({
    todos: z
      .array(TodoItemSchema)
      .describe(
        "The complete updated list. This replaces the current list; do not send only the changed items.",
      ),
  });

  return defineTool<never, z.infer<typeof parameters>>({
    name: "manage_todos",
    disclosure: "personal",
    description:
      "Replace this conversation's todo list, which steers the run and shows progress in the UI. Every call replaces the whole list — send every item, not just the ones that changed. " +
      "Use this when the work has three or more distinct steps; skip it for one-liners. Keep exactly one item in_progress, and mark it completed as soon as it is finished. " +
      "This list belongs to the current conversation and does not survive compaction on its own. It is not memory, not work state, and not a reminder. " +
      "For a plan that must survive compaction, also call update_work_state. To ping someone at a clock time, use add_reminder.",
    parameters,
    riskLevel: "low-risk",
    hidden: false,
    validate: makeZodValidator(parameters),
    createSummary: (result: ToolExecutionResult) => {
      if (!result.success) return undefined;
      const data = result.result as ReturnType<typeof computeStats>;
      return `Todos updated: ${data.completed}/${data.totalItems} done, ${data.inProgress} in progress, ${data.pending} pending`;
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const { todos } = args;
        const conversationId = context?.conversationId ?? "default";

        const inProgressCount = todos.filter((item) => item.status === "in_progress").length;
        if (inProgressCount > 1) {
          return {
            success: false,
            result: null,
            error: "At most one todo may be in_progress at a time.",
          } satisfies ToolExecutionResult;
        }

        yield* writeTodos(conversationId, todos);

        const stats = computeStats(todos);
        return {
          success: true,
          result: {
            ...stats,
            todos,
            message: `Todo list saved (${stats.totalItems} items: ${stats.completed} done, ${stats.inProgress} in progress, ${stats.pending} pending, ${stats.cancelled} cancelled)`,
          },
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
  });
}

/**
 * `list_todos` — reads the current todo list from the temp file.
 */
export function createListTodosTool(): Tool<never> {
  return defineTool({
    name: "list_todos",
    disclosure: "personal",
    description: "Read the current todo list. Returns all items with their status and priority.",
    parameters: z.object({}),
    riskLevel: "read-only",
    hidden: false,
    createSummary: (result: ToolExecutionResult) => {
      if (!result.success) return undefined;
      const data = result.result as { totalItems: number };
      return data.totalItems === 0 ? "No todos" : `${data.totalItems} todo(s)`;
    },
    handler: (_args, context) =>
      Effect.gen(function* () {
        const conversationId = context?.conversationId ?? "default";
        const todos = yield* readTodos(conversationId);

        if (todos.length === 0) {
          return {
            success: true,
            result: {
              totalItems: 0,
              todos: [],
              message: "No todos found. Use manage_todos to create a todo list.",
            },
          } satisfies ToolExecutionResult;
        }

        return {
          success: true,
          result: {
            ...computeStats(todos),
            todos,
          },
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
  });
}
