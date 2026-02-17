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
 */
const TodoItemSchema = z.object({
  content: z.string().describe("Brief description of the task"),
  status: z
    .enum(["pending", "in_progress", "completed", "cancelled"])
    .describe("Current status of the task"),
  priority: z
    .enum(["high", "medium", "low"])
    .describe("Priority level of the task")
    .default("medium"),
});

type TodoItem = z.infer<typeof TodoItemSchema>;

// ---------------------------------------------------------------------------
// Temp-file helpers (Effect-based, async)
// ---------------------------------------------------------------------------

function getTodoFilePath(sessionId: string): string {
  return path.join(os.tmpdir(), `jazz-todos-${sessionId}.json`);
}

function readTodos(sessionId: string): Effect.Effect<TodoItem[], Error> {
  const filePath = getTodoFilePath(sessionId);
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

function writeTodos(sessionId: string, todos: TodoItem[]): Effect.Effect<void, Error> {
  const filePath = getTodoFilePath(sessionId);
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
      .describe("The complete, updated todo list — replaces the current list"),
  });

  return defineTool<never, z.infer<typeof parameters>>({
    name: "manage_todos",
    description:
      "Create or update the todo list. Send the FULL list of items each time (replaces the previous list). " +
      "Use this to plan multi-step work, track progress, and mark items complete as you go.",
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
        const sessionId = context?.sessionId ?? "default";

        yield* writeTodos(sessionId, todos);

        const stats = computeStats(todos);
        return {
          success: true,
          result: {
            ...stats,
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
        const sessionId = context?.sessionId ?? "default";
        const todos = yield* readTodos(sessionId);

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
