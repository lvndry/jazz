/**
 * Sub-agents through the tools the model calls: spawn_subagent, then list_subagents,
 * wait_subagents and steer_subagent against the run's supervisor. The child
 * run itself is replaced, so these tests control when it finishes and see what it was given.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Deferred, Effect, Layer } from "effect";
import type { LoggerService } from "@/core/interfaces/logger";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import type { PresentationService } from "@/core/interfaces/presentation";
import { PresentationServiceTag } from "@/core/interfaces/presentation";
import type { Agent } from "@/core/types";
import type { ToolExecutionResult } from "@/core/types/tools";
import { formatToolResultForContext } from "@/core/utils/tool-result-formatter";
import { createSubagentTools } from "./subagent";
import { AgentRunner } from "../agent-runner";
import {
  createSubagentSupervisor,
  MAX_LIVE_SUBAGENTS,
  type SubagentSupervisor,
} from "../subagents/supervisor";
import { silentLogger } from "../test-logger";
import type { AgentRunnerOptions } from "../types";

const parentAgent: Agent = {
  id: "parent",
  name: "parent",
  config: { persona: "default", llm: { provider: "openai", model: "gpt-test" } },
  createdAt: new Date(),
  updatedAt: new Date(),
};

const recordedParentMessages: { regionId: string; message: string }[] = [];

const presentation = {
  writeOutput: () => Effect.void,
  openEphemeralRegion: () => Effect.succeed("eph-test"),
  appendEphemeralRegion: () => Effect.void,
  collapseEphemeralRegion: () => Effect.void,
  recordEphemeralRegionParentMessage: (regionId: string, message: string) =>
    Effect.sync(() => {
      recordedParentMessages.push({ regionId, message });
    }),
} as unknown as PresentationService;

const layer = Layer.mergeAll(
  Layer.succeed(LoggerServiceTag, silentLogger),
  Layer.succeed(PresentationServiceTag, presentation),
);

function tool(name: string) {
  const found = createSubagentTools().find((candidate) => candidate.name === name);
  if (found === undefined) {
    throw new Error(`${name} not found`);
  }
  return found;
}

function call(
  name: string,
  args: Record<string, unknown>,
  supervisor: SubagentSupervisor | undefined,
): Promise<ToolExecutionResult> {
  return Effect.runPromise(
    (
      tool(name).execute(args, {
        agentId: parentAgent.id,
        parentAgent,
        ...(supervisor !== undefined ? { subagents: supervisor } : {}),
      }) as Effect.Effect<ToolExecutionResult, unknown, LoggerService | PresentationService>
    ).pipe(Effect.provide(layer)),
  );
}

/** Replace the child run with one that answers once `answers` gives it text. */
function mockChildren() {
  const started: AgentRunnerOptions[] = [];
  const answers: Deferred.Deferred<string>[] = [];
  const spy = spyOn(AgentRunner, "runRecursive").mockImplementation((options) => {
    started.push(options as AgentRunnerOptions);
    const answer = Effect.runSync(Deferred.make<string>());
    answers.push(answer);
    return Effect.gen(function* () {
      yield* options.beforeStep?.() ?? Effect.void;
      const content = yield* Deferred.await(answer);
      return { content, conversationId: "child", messages: [] };
    }) as ReturnType<typeof AgentRunner.runRecursive>;
  });
  return { started, answers, spy };
}

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

describe("sub-agents the parent steers", () => {
  it("returns an agentId at once, and wait_subagents returns the child's answer", async () => {
    const children = mockChildren();
    restore = () => children.spy.mockRestore();
    const supervisor = await Effect.runPromise(createSubagentSupervisor());

    const spawned = await call(
      "spawn_subagent",
      { task: "price the flights", name: "flights" },
      supervisor,
    );
    expect(spawned.success).toBe(true);
    const agentId = (spawned.result as { agentId: string }).agentId;
    expect(agentId).toMatch(/^sa-\d+$/);
    expect(supervisor.list()[0]).toMatchObject({ id: agentId, status: "running" });

    const waiting = call("wait_subagents", { ids: [agentId] }, supervisor);
    await Effect.runPromise(Deferred.succeed(children.answers[0]!, "Lisbon, €84 return"));
    const waited = await waiting;
    expect(waited.result).toMatchObject({
      timedOut: false,
      subagents: [{ id: agentId, status: "completed", result: "Lisbon, €84 return" }],
    });
  });

  it("returns every child's answer within one tool result when they overflow it", async () => {
    const children = mockChildren();
    restore = () => children.spy.mockRestore();
    const supervisor = await Effect.runPromise(createSubagentSupervisor());
    await call("spawn_subagent", { task: "market", name: "market" }, supervisor);
    await call("spawn_subagent", { task: "rates", name: "rates" }, supervisor);
    await Effect.runPromise(
      Deferred.succeed(children.answers[0]!, "market finding\n".repeat(3_000)),
    );
    await Effect.runPromise(
      Deferred.succeed(children.answers[1]!, "rates finding\n".repeat(1_600)),
    );

    const waited = await call("wait_subagents", {}, supervisor);
    const formatted = formatToolResultForContext("wait_subagents", waited.result);

    expect(formatted).not.toContain("[truncated");
    const shown = JSON.parse(formatted) as { subagents: { name: string; result: string }[] };
    expect(shown.subagents.map((child) => child.name)).toEqual(["market", "rates"]);
    for (const child of shown.subagents) {
      expect(child.result).toContain(`${child.name} finding`);
    }
  });

  it("gives the child the hooks the parent steers it with and the shared cost pool", async () => {
    const children = mockChildren();
    restore = () => children.spy.mockRestore();
    const supervisor = await Effect.runPromise(createSubagentSupervisor());
    await call("spawn_subagent", { task: "t" }, supervisor);
    const options = children.started[0]!;
    expect(options.beforeStep).toBeDefined();
    expect(options.onIterationSpend).toBeDefined();
    expect(options.onToolEvent).toBeDefined();
    expect(options.sharedCostExhausted).toBeDefined();
    expect(options.checkQueuedMessage).toBeDefined();
  });

  it("delivers a steer_subagent message to the child, labelled as the parent's", async () => {
    const children = mockChildren();
    restore = () => children.spy.mockRestore();
    const supervisor = await Effect.runPromise(createSubagentSupervisor());
    const spawned = await call("spawn_subagent", { task: "t" }, supervisor);
    const agentId = (spawned.result as { agentId: string }).agentId;

    const steered = await call(
      "steer_subagent",
      { id: agentId, action: "message", message: "only direct flights" },
      supervisor,
    );
    expect(steered.success).toBe(true);
    const delivered = children.started[0]!.checkQueuedMessage?.();
    expect(delivered).toContain("[MESSAGE FROM THE PARENT AGENT WHILE YOU WORK]");
    expect(delivered).toContain("only direct flights");
    expect(children.started[0]!.checkQueuedMessage?.()).toBeUndefined();
    expect(recordedParentMessages.at(-1)).toEqual({
      regionId: "eph-test",
      message: "only direct flights",
    });
  });

  it("cancels a child and reports it cancelled", async () => {
    const children = mockChildren();
    restore = () => children.spy.mockRestore();
    const supervisor = await Effect.runPromise(createSubagentSupervisor());
    const spawned = await call("spawn_subagent", { task: "t" }, supervisor);
    const agentId = (spawned.result as { agentId: string }).agentId;

    const cancelled = await call("steer_subagent", { id: agentId, action: "cancel" }, supervisor);
    expect(cancelled.result).toMatchObject({ status: "cancelled" });
    const listed = await call("list_subagents", {}, supervisor);
    expect(listed.result).toMatchObject({
      subagents: [{ id: agentId, status: "cancelled", error: "Cancelled by the parent agent." }],
    });
  });

  it(`refuses a spawn past ${String(MAX_LIVE_SUBAGENTS)} live children`, async () => {
    const children = mockChildren();
    restore = () => children.spy.mockRestore();
    const supervisor = await Effect.runPromise(createSubagentSupervisor());
    for (let index = 0; index < MAX_LIVE_SUBAGENTS; index++) {
      expect((await call("spawn_subagent", { task: "t" }, supervisor)).success).toBe(true);
    }
    const refused = await call("spawn_subagent", { task: "t" }, supervisor);
    expect(refused.success).toBe(false);
    expect(refused.error).toContain("wait_subagents");
    expect(children.started).toHaveLength(MAX_LIVE_SUBAGENTS);
  });

  it("refuses to delegate in a run that cannot hold sub-agents", async () => {
    const result = await call("spawn_subagent", { task: "t" }, undefined);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Do this task yourself");
  });

  it("names an unknown agentId in wait_subagents", async () => {
    const supervisor = await Effect.runPromise(createSubagentSupervisor());
    const result = await call("wait_subagents", { ids: ["sa-999"] }, supervisor);
    expect(result.success).toBe(false);
    expect(result.error).toContain("sa-999");
  });
});
