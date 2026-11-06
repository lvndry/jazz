/**
 * Golden-session scenarios: the real agent runner, tool registry, approval gate, checkpointing
 * and conversation persistence, with only the model replayed from a recorded fixture.
 * Run with `bun test packages/adapters/src/llm/golden/scenarios.test.ts`.
 *
 * Assertions are semantic (roles, tool names and argument keys, result statuses, parked and
 * checkpoint states, usage present). Never snapshot text, and never regenerate a fixture to make
 * a failing assertion pass: a failure means behavior changed, so decide whether the change is
 * intended before touching either side. See docs/maintainers/golden-sessions.md.
 */

import { stoppedToolCallResult } from "@jazz/core/agent/execution/tool-batch-ledger";
import { afterEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { z } from "zod";
import type { GoldenFixture } from "./fixture";
import approvalParkResume from "./fixtures/approval-park-resume.json";
import emptyFinishRetry from "./fixtures/empty-finish-retry.json";
import interruptedBatch from "./fixtures/interrupted-batch.json";
import plainAnswer from "./fixtures/plain-answer.json";
import toolCallResult from "./fixtures/tool-call-result.json";
import {
  createGoldenSession,
  type GoldenRunExit,
  type GoldenSession,
  type ScenarioTool,
} from "../../test-support/golden/harness";
import {
  eventTypesOf,
  finalAssistantText,
  reportedUsage,
  rolesOf,
  toolCallsOf,
  toolResultsOf,
  unansweredToolCallIds,
} from "../../test-support/golden/transcript";

const lookupNote: ScenarioTool = {
  name: "lookup_note",
  description: "Read a saved note by its title.",
  parameters: z.object({ title: z.string() }),
  riskLevel: "read-only",
  execute: () => Effect.succeed("Standup notes: 10:00 every weekday, room 4."),
};

const sessions: GoldenSession[] = [];

function open(fixture: unknown, tools: readonly ScenarioTool[]): GoldenSession {
  const session = createGoldenSession({ fixture: fixture as GoldenFixture, tools });
  sessions.push(session);
  return session;
}

function describeUnexpectedExit(session: GoldenSession, exit: GoldenRunExit): string {
  const drift = session.replay.divergences.join("\n");
  return `unexpected run exit: ${exit.kind}${drift === "" ? "" : `\n${drift}`}`;
}

afterEach(() => {
  for (const session of sessions.splice(0)) {
    session.cleanup();
  }
});

describe("golden session: plain answer", () => {
  it("answers in one model call with usage, a persisted transcript and no tool traffic", async () => {
    const session = open(plainAnswer, [lookupNote]);

    const exit = await session.run({ userInput: "when is the standup?" });
    if (exit.kind !== "completed") {
      throw new Error(describeUnexpectedExit(session, exit));
    }

    session.replay.assertExhausted();
    expect(session.replay.divergences).toEqual([]);
    expect(rolesOf(exit.messages)).toEqual(["user", "assistant"]);
    expect(finalAssistantText(exit.messages)?.length).toBeGreaterThan(0);
    expect(toolCallsOf(exit.messages)).toEqual([]);
    expect(eventTypesOf(session.events)).toContain("stream_start");
    expect(eventTypesOf(session.events)).toContain("complete");
    const usage = reportedUsage(session.events);
    expect(usage?.promptTokens).toBeGreaterThan(0);
    expect(usage?.completionTokens).toBeGreaterThan(0);

    const saved = await session.loadSaved();
    expect(rolesOf(saved)).toEqual(["user", "assistant"]);
    expect(unansweredToolCallIds(saved)).toEqual([]);
    expect(toolResultsOf(saved)).toEqual([]);
  });
});

describe("golden session: tool call with its result fed back", () => {
  it("runs the tool once, answers its call, and lets the model see the result", async () => {
    const session = open(toolCallResult, [lookupNote]);

    const exit = await session.run({ userInput: "what do my notes say about standup?" });
    if (exit.kind !== "completed") {
      throw new Error(describeUnexpectedExit(session, exit));
    }

    session.replay.assertExhausted();
    expect(rolesOf(exit.messages)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(toolCallsOf(exit.messages)).toEqual([{ name: "lookup_note", argumentKeys: ["title"] }]);
    const results = toolResultsOf(exit.messages);
    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("lookup_note");
    expect(results[0]?.answersACall).toBe(true);
    expect(results[0]?.content.length).toBeGreaterThan(0);
    expect(unansweredToolCallIds(exit.messages)).toEqual([]);
    expect(finalAssistantText(exit.messages)?.length).toBeGreaterThan(0);

    expect(session.replay.requests[1]?.toolResults.map((result) => result.toolName)).toEqual([
      "lookup_note",
    ]);
    expect(reportedUsage(session.events)?.promptTokens).toBeGreaterThan(0);
    expect(eventTypesOf(session.events)).toContain("tool_call");
  });
});

describe("golden session: mutating tool parks for approval, then resumes", () => {
  it("withholds the call until approved, runs it exactly once on resume, then answers", async () => {
    const applied: Record<string, unknown>[] = [];
    const applyChange: ScenarioTool = {
      name: "apply_change",
      description: "Overwrite a note file.",
      parameters: z.object({ path: z.string(), content: z.string() }),
      riskLevel: "high-risk",
      execute: (args) =>
        Effect.sync(() => {
          applied.push(args);
          return "applied";
        }),
    };
    const session = open(approvalParkResume, [lookupNote, applyChange]);

    const parked = await session.run({
      userInput: "move the standup note to 10:30",
      parkWhenUnattended: true,
    });

    expect(parked.kind).toBe("parked");
    expect(applied).toEqual([]);
    const runs = await Effect.runPromise(session.runStore.list());
    expect(runs).toHaveLength(1);
    const state = runs[0]?.state;
    if (state?.kind !== "input-required" || state.pending.kind !== "tool-approval") {
      throw new Error(`expected a run parked on a tool approval, got ${state?.kind}`);
    }
    expect(state.pending.request.toolCallId).toBeDefined();
    expect(toolCallsOf(state.snapshot.messages)).toEqual([
      { name: "apply_change", argumentKeys: ["content", "path"] },
    ]);
    expect(toolResultsOf(state.snapshot.messages)).toEqual([]);
    expect(session.checkpoints.map((checkpoint) => checkpoint.phase)).toContain("pre-execution");

    const resumed = await session.resumeParked(true);

    expect(resumed.kind).toBe("completed");
    session.replay.assertExhausted();
    expect(session.replay.divergences).toEqual([]);
    expect(applied).toHaveLength(1);
    expect(Object.keys(applied[0] ?? {}).sort()).toEqual(["content", "path"]);
    const finished = await Effect.runPromise(session.runStore.get(runs[0]?.runId ?? ""));
    expect(finished?.state.kind).toBe("completed");
    expect(await Effect.runPromise(session.runStore.list())).toHaveLength(0);
  });
});

describe("golden session: empty model finish is retried", () => {
  it("asks again after a finish with no text and no tool call, then answers", async () => {
    const session = open(emptyFinishRetry, [lookupNote]);

    const exit = await session.run({ userInput: "when is the standup?" });
    if (exit.kind !== "completed") {
      throw new Error(describeUnexpectedExit(session, exit));
    }

    session.replay.assertExhausted();
    expect(session.replay.requests).toHaveLength(2);
    expect(session.replay.requests[1]?.messageRoles).toEqual(
      session.replay.requests[0]?.messageRoles ?? [],
    );
    expect(rolesOf(exit.messages)).toEqual(["user", "assistant"]);
    expect(finalAssistantText(exit.messages)?.length).toBeGreaterThan(0);
    expect(exit.iterationLimited).toBe(false);
  });
});

describe("golden session: a killed tool batch leaves an interrupted record", () => {
  it("saves a checkpoint before the batch that closes the call as interrupted", async () => {
    let signalStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const applyChange: ScenarioTool = {
      name: "apply_change",
      description: "Overwrite a note file.",
      parameters: z.object({ path: z.string(), content: z.string() }),
      riskLevel: "high-risk",
      execute: () => Effect.sync(signalStarted).pipe(Effect.flatMap(() => Effect.never)),
    };
    const session = open(interruptedBatch, [lookupNote, applyChange]);

    const turn = session.start({
      userInput: "move the standup note to 10:30",
      autoApprovePolicy: "high-risk",
    });
    await started;
    await turn.interrupt();

    expect((await turn.done).kind).toBe("interrupted");
    const preExecution = session.checkpoints.filter(
      (checkpoint) => checkpoint.phase === "pre-execution",
    );
    expect(preExecution).toHaveLength(1);

    const saved = await session.loadSaved();
    expect(rolesOf(saved)).toEqual(["user", "assistant", "tool"]);
    expect(toolCallsOf(saved)).toEqual([
      { name: "apply_change", argumentKeys: ["content", "path"] },
    ]);
    expect(unansweredToolCallIds(saved)).toEqual([]);
    const [result] = toolResultsOf(saved);
    expect(result?.name).toBe("apply_change");
    expect(result?.answersACall).toBe(true);
    const interruptedLead = stoppedToolCallResult("interrupted", "").split("(")[0] ?? "";
    expect(interruptedLead.length).toBeGreaterThan(0);
    expect(result?.content.startsWith(interruptedLead)).toBe(true);
    expect(finalAssistantText(saved)).toBeUndefined();
  });
});
