import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type { Agent } from "@/core/types";
import type { EgressTaint, ToolExecutionContext, ToolExecutionResult } from "@/core/types/tools";
import { createBlackboardTools, fitBlackboardRead } from "./blackboard";
import { createBlackboard, type Blackboard } from "../subagents/blackboard";

const childAgent = { id: "child", name: "doc 2" } as Agent;

function tool(name: string) {
  const found = createBlackboardTools().find((candidate) => candidate.name === name);
  if (found === undefined) {
    throw new Error(`${name} not found`);
  }
  return found;
}

function taint(tainted: boolean): EgressTaint {
  return { isTainted: () => tainted } as EgressTaint;
}

function call(
  name: string,
  args: Record<string, unknown>,
  context: Partial<ToolExecutionContext>,
): Promise<ToolExecutionResult> {
  return Effect.runPromise(
    tool(name).execute(args, {
      agentId: childAgent.id,
      parentAgent: childAgent,
      ...context,
    }) as Effect.Effect<ToolExecutionResult>,
  );
}

describe("blackboard tools", () => {
  it("posts under the agent's name and reads it back", async () => {
    const blackboard = createBlackboard();
    const posted = await call(
      "post_to_blackboard",
      { topic: "auth", content: "refresh lives in src/auth/refresh.ts" },
      { blackboard },
    );
    expect(posted).toMatchObject({ success: true, result: { id: 1 } });

    const read = await call("read_blackboard", {}, { blackboard });
    expect(read.result).toMatchObject({
      entries: [{ id: 1, author: "doc 2", topic: "auth" }],
      nextAfterId: 1,
    });
    expect(read.untrusted).toBeUndefined();
  });

  it("carries a tainted author's provenance to whoever reads the post", async () => {
    const blackboard: Blackboard = createBlackboard();
    await call(
      "post_to_blackboard",
      { topic: "pricing", content: "competitor charges $12" },
      { blackboard, egressTaint: taint(true) },
    );
    const read = await call("read_blackboard", {}, { blackboard, egressTaint: taint(false) });
    expect(read.untrusted).toEqual({ kind: "external", source: "blackboard posts by doc 2" });
  });

  it("refuses without a board", async () => {
    const read = await call("read_blackboard", {}, {});
    expect(read.success).toBe(false);
  });
});

describe("fitBlackboardRead", () => {
  it("stops at the size budget and points the reader at the next post", () => {
    const board = createBlackboard();
    for (let index = 0; index < 5; index++) {
      board.post({ author: "doc", topic: "bulk", content: "x".repeat(1_000) });
    }
    const fitted = fitBlackboardRead(board.read({}), 2_500);
    expect(fitted.entries.map((entry) => entry.id)).toEqual([1, 2]);
    expect(fitted).toMatchObject({ nextAfterId: 2, more: 3 });
  });

  it("returns one post even when it alone is over the budget", () => {
    const board = createBlackboard();
    board.post({ author: "doc", topic: "big", content: "x".repeat(5_000) });
    expect(fitBlackboardRead(board.read({}), 100).entries).toHaveLength(1);
  });
});
