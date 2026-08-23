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
 * `unverified` came from work state, which kept a second, parallel list of the same work
 * under a different vocabulary. Its one genuinely good idea was refusing to let an agent
 * call something finished on the strength of having written it, so that distinction moved
 * here and the second list went away.
 */
const TodoItemSchema = z.object({
  content: z.string().describe("What this step is."),
  status: z
    .enum(["pending", "in_progress", "unverified", "completed", "cancelled"])
    .describe(
      'pending, in_progress, unverified, completed, or cancelled. Use "completed" only ' +
        'when you have run something that confirms it works; use "unverified" when you ' +
        "believe it is finished but have not checked.",
    ),
  verifiedBy: z
    .string()
    .optional()
    .describe('What you ran to confirm it, e.g. "bun test src/foo.test.ts".'),
  priority: z.enum(["high", "medium", "low"]).describe("high, medium, or low.").default("medium"),
});

type TodoItem = z.infer<typeof TodoItemSchema>;

// ---------------------------------------------------------------------------
// Temp-file helpers (Effect-based, async)
// ---------------------------------------------------------------------------

function getTodoFilePath(logScope: string): string {
  return path.join(os.tmpdir(), `jazz-todos-${logScope}.json`);
}

function readTodos(logScope: string): Effect.Effect<TodoItem[], Error> {
  const filePath = getTodoFilePath(logScope);
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

function writeTodos(logScope: string, todos: TodoItem[]): Effect.Effect<void, Error> {
  const filePath = getTodoFilePath(logScope);
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
    description:
      "Replace the in-session task list used to steer this run and show progress in the UI. Every call replaces the whole list — send every item, not just the ones that changed. " +
      "Use this when the work has three or more distinct steps; skip it for one-liners. Keep exactly one item in_progress, and mark it completed as soon as it is finished. " +
      "This list is session scratch and does not survive compaction on its own. It is not memory, not task state, and not a reminder. " +
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
        const logScope = context?.logScope ?? "default";

        const inProgressCount = todos.filter((item) => item.status === "in_progress").length;
        if (inProgressCount > 1) {
          return {
            success: false,
            result: null,
            error: "At most one todo may be in_progress at a time.",
          } satisfies ToolExecutionResult;
        }

        yield* writeTodos(logScope, todos);

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
        const logScope = context?.logScope ?? "default";
        const todos = yield* readTodos(logScope);

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
