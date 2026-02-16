import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import { z } from "zod";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { ToolExecutionResult } from "@/core/types/tools";

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
// Temp-file helpers
// ---------------------------------------------------------------------------

function getTodoFilePath(sessionId: string): string {
  return path.join(os.tmpdir(), `jazz-todos-${sessionId}.json`);
}

function readTodos(sessionId: string): TodoItem[] {
  const filePath = getTodoFilePath(sessionId);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeTodos(sessionId: string, todos: TodoItem[]): void {
  const filePath = getTodoFilePath(sessionId);
  fs.writeFileSync(filePath, JSON.stringify(todos, null, 2), "utf-8");
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
  return {
    name: "manage_todos",
    description:
      "Create or update the todo list. Send the FULL list of items each time (replaces the previous list). " +
      "Use this to plan multi-step work, track progress, and mark items complete as you go.",
    parameters: z.object({
      todos: z
        .array(TodoItemSchema)
        .describe("The complete, updated todo list — replaces the current list"),
    }),
    riskLevel: "low-risk",
    hidden: false,
    createSummary: (result: ToolExecutionResult) => {
      if (!result.success) return undefined;
      const data = result.result as {
        totalItems: number;
        pending: number;
        inProgress: number;
        completed: number;
      };
      return `Todos updated: ${data.completed}/${data.totalItems} done, ${data.inProgress} in progress, ${data.pending} pending`;
    },
    execute: (args: Record<string, unknown>, context) => {
      const parsed = z
        .object({
          todos: z.array(TodoItemSchema),
        })
        .safeParse(args);

      if (!parsed.success) {
        const errors = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
        return Effect.succeed({
          success: false,
          result: null,
          error: errors.join("; "),
        } satisfies ToolExecutionResult);
      }

      const { todos } = parsed.data;
      const sessionId = context?.sessionId ?? "default";

      writeTodos(sessionId, todos);

      const pending = todos.filter((t) => t.status === "pending").length;
      const inProgress = todos.filter((t) => t.status === "in_progress").length;
      const completed = todos.filter((t) => t.status === "completed").length;
      const cancelled = todos.filter((t) => t.status === "cancelled").length;

      return Effect.succeed({
        success: true,
        result: {
          totalItems: todos.length,
          pending,
          inProgress,
          completed,
          cancelled,
          message: `Todo list saved (${todos.length} items: ${completed} done, ${inProgress} in progress, ${pending} pending, ${cancelled} cancelled)`,
        },
      } satisfies ToolExecutionResult);
    },
  };
}

/**
 * `list_todos` — reads the current todo list from the temp file.
 */
export function createListTodosTool(): Tool<never> {
  return {
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
    execute: (_args: Record<string, unknown>, context) => {
      const sessionId = context?.sessionId ?? "default";
      const todos = readTodos(sessionId);

      if (todos.length === 0) {
        return Effect.succeed({
          success: true,
          result: {
            totalItems: 0,
            todos: [],
            message: "No todos found. Use manage_todos to create a todo list.",
          },
        } satisfies ToolExecutionResult);
      }

      const pending = todos.filter((t) => t.status === "pending").length;
      const inProgress = todos.filter((t) => t.status === "in_progress").length;
      const completed = todos.filter((t) => t.status === "completed").length;
      const cancelled = todos.filter((t) => t.status === "cancelled").length;

      return Effect.succeed({
        success: true,
        result: {
          totalItems: todos.length,
          pending,
          inProgress,
          completed,
          cancelled,
          todos,
        },
      } satisfies ToolExecutionResult);
    },
  };
}
