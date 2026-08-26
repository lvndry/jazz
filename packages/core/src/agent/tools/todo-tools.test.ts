import * as nodeFs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type { ToolExecutionContext } from "@/core/types/tools";
import { createListTodosTool, createManageTodosTool } from "./todo-tools";

const manageTodos = createManageTodosTool();
const listTodos = createListTodosTool();

/** Unique per test run, since todo files live in the shared system temp directory. */
const suffix = `${String(process.pid)}-${String(Math.floor(performance.now()))}`;
const conversations: string[] = [];

function context(conversationId: string): ToolExecutionContext {
  const scoped = `${conversationId}-${suffix}`;
  conversations.push(scoped);
  return { agentId: "agent-1", conversationId: scoped } as ToolExecutionContext;
}

const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(effect);

afterEach(async () => {
  await Promise.all(
    conversations.map((conversationId) =>
      nodeFs.rm(path.join(os.tmpdir(), `jazz-todos-${conversationId}.json`), { force: true }),
    ),
  );
  conversations.length = 0;
});

describe("manage_todos", () => {
  it("round-trips a list within one conversation", async () => {
    const conversation = context("conv-round-trip");
    await run(
      manageTodos.execute(
        { todos: [{ content: "write the parser", status: "in_progress", priority: "high" }] },
        conversation,
      ),
    );

    const listed = (await run(listTodos.execute({}, conversation))) as {
      result: { todos: { content: string }[] };
    };
    expect(listed.result.todos.map((todo) => todo.content)).toEqual(["write the parser"]);
  });

  it("keeps each conversation's list to itself", async () => {
    // The bug this guards: todos used to be keyed by a per-sitting id that `/new` did not
    // change, so a fresh conversation opened holding the previous one's list.
    await run(
      manageTodos.execute(
        { todos: [{ content: "belongs to the first", status: "pending", priority: "medium" }] },
        context("conv-first"),
      ),
    );

    const second = (await run(listTodos.execute({}, context("conv-second")))) as {
      result: { totalItems: number };
    };
    expect(second.result.totalItems).toBe(0);
  });

  it("keeps verifiedBy alongside a completed todo", async () => {
    const conversation = context("conv-verified");
    await run(
      manageTodos.execute(
        {
          todos: [
            {
              content: "wire the endpoint",
              status: "completed",
              priority: "medium",
              verifiedBy: "bun test src/api.test.ts",
            },
            { content: "write the docs", status: "completed", priority: "low" },
          ],
        },
        conversation,
      ),
    );

    const listed = (await run(listTodos.execute({}, conversation))) as {
      result: { todos: { verifiedBy?: string }[] };
    };
    expect(listed.result.todos[0]?.verifiedBy).toBe("bun test src/api.test.ts");
    // Completed with nothing recorded is the honest "written but never run" case.
    expect(listed.result.todos[1]?.verifiedBy).toBeUndefined();
  });

  it("refuses more than one item in progress", async () => {
    const result = (await run(
      manageTodos.execute(
        {
          todos: [
            { content: "one", status: "in_progress", priority: "medium" },
            { content: "two", status: "in_progress", priority: "medium" },
          ],
        },
        context("conv-two-active"),
      ),
    )) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toContain("in_progress");
  });
});
