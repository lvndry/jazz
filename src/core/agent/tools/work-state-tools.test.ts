import * as nodeFs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { readWorkState } from "@/core/agent/context/work-state";
import type { ToolExecutionContext } from "@/core/types/tools";
import { createUpdateWorkStateTool } from "./work-state-tools";

const tool = createUpdateWorkStateTool();

function context(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    agentId: "agent-1",
    conversationId: "conv-1",
    ...overrides,
  } as ToolExecutionContext;
}

const run = <A>(effect: Effect.Effect<A, never, never>): Promise<A> => Effect.runPromise(effect);

describe("update_work_state", () => {
  let jazzHome: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    jazzHome = await nodeFs.mkdtemp(path.join(os.tmpdir(), "jazz-task-tool-"));
    previousHome = process.env["JAZZ_HOME"];
    process.env["JAZZ_HOME"] = jazzHome;
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env["JAZZ_HOME"];
    else process.env["JAZZ_HOME"] = previousHome;
    await nodeFs.rm(jazzHome, { recursive: true, force: true });
  });

  it("writes the fields it is given", async () => {
    const result = (await run(
      tool.execute({ goal: "migrate routes", nextStep: "start with auth" }, context()) as any,
    )) as any;

    expect(result.success).toBe(true);
    const state = await run(readWorkState("agent-1", "conv-1"));
    expect(state?.goal).toBe("migrate routes");
    expect(state?.nextStep).toBe("start with auth");
    expect(state?.updatedAt).toBeDefined();
  });

  it("patches without clobbering fields it was not given", async () => {
    await run(tool.execute({ goal: "migrate routes", decisions: ["keep v1"] }, context()) as any);
    await run(tool.execute({ nextStep: "auth route" }, context()) as any);

    const state = await run(readWorkState("agent-1", "conv-1"));
    expect(state?.goal).toBe("migrate routes");
    expect(state?.decisions).toEqual(["keep v1"]);
    expect(state?.nextStep).toBe("auth route");
  });

  it("reads back current state when called with no fields", async () => {
    await run(tool.execute({ goal: "migrate routes" }, context()) as any);
    const result = (await run(tool.execute({}, context()) as any)) as any;

    expect(result.success).toBe(true);
    expect(result.result.formatted).toContain("migrate routes");
  });

  it("fails clearly when there is no conversation to attach state to", async () => {
    const result = (await run(
      tool.execute({ goal: "x" }, context({ conversationId: undefined })) as any,
    )) as any;

    expect(result.success).toBe(false);
    expect(result.error).toContain("No conversation");
  });

  it("keeps state out of the memory directory", async () => {
    await run(tool.execute({ goal: "migrate routes" }, context()) as any);

    const memoryDir = path.join(jazzHome, "memory");
    const memoryExists = await nodeFs
      .stat(memoryDir)
      .then(() => true)
      .catch(() => false);
    expect(memoryExists).toBe(false);
  });
});
