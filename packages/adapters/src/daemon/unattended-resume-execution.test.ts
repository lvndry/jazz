/**
 * Exercises unattended wake delivery through the real claim, turn and settlement paths.
 * Each test owns a private Jazz home and restores its runner spy; only the model run is
 * substituted, so failed answers must survive on disk for retry while parks and partial
 * budget results retain their existing delivery semantics.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { AgentRunner } from "@jazz/core/agent/agent-runner";
import { RunParkRequested } from "@jazz/core/agent/run/park-signal";
import type { AgentResponse } from "@jazz/core/agent/types";
import { AgentServiceTag, type AgentService } from "@jazz/core/interfaces/agent-service";
import { LoggerServiceTag, type LoggerService } from "@jazz/core/interfaces/logger";
import type { Agent } from "@jazz/core/types/agent";
import type { DeliveryOutcome } from "@jazz/core/utils/delivery";
import { readStateFile, writeStateFile } from "@jazz/core/utils/state-file";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Effect, Layer } from "effect";
import {
  claimDueWakeTriggers,
  settleWakeTrigger,
  WAKE_TRIGGER_STORE,
} from "../wake-trigger-service";
import { runUnattendedTurn } from "./unattended-resume";

const agent: Agent = {
  id: "test-agent",
  name: "test-agent",
  config: { persona: "default", llmProvider: "openai", llmModel: "gpt-4o-mini" },
  createdAt: new Date(0),
  updatedAt: new Date(0),
};
const logger = {
  debug: () => Effect.void,
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
} as unknown as LoggerService;

describe("unattended answer delivery", () => {
  let previousHome: string | undefined;
  let home: string;
  let runner: ReturnType<typeof spyOn<typeof AgentRunner, "run">>;
  let response: AgentResponse;

  beforeEach(() => {
    previousHome = process.env["JAZZ_HOME"];
    home = mkdtempSync(join(tmpdir(), "jazz-unattended-answer-"));
    process.env["JAZZ_HOME"] = home;
    response = {
      content: "",
      conversationId: "conversation",
      finishReason: "stop",
      emptyCompletion: true,
    };
    runner = spyOn(AgentRunner, "run").mockImplementation(() => Effect.succeed(response));
  });
  afterEach(() => {
    runner.mockRestore();
    if (previousHome === undefined) delete process.env["JAZZ_HOME"];
    else process.env["JAZZ_HOME"] = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  async function deliver() {
    const directory = join(home, "wake-triggers");
    const file = WAKE_TRIGGER_STORE.filePath(directory, agent.id);
    await Effect.runPromise(
      writeStateFile(file, WAKE_TRIGGER_STORE.kind, [
        {
          id: "wake",
          conversationId: "conversation",
          fireAt: 0,
          createdAt: 0,
          prompt: "Check and report the build result",
          reason: "Follow up",
        },
      ]),
    );
    expect(await Effect.runPromise(claimDueWakeTriggers(directory, Date.now()))).toHaveLength(1);
    const services = Layer.mergeAll(
      NodeFileSystem.layer,
      Layer.succeed(LoggerServiceTag, logger),
      Layer.succeed(AgentServiceTag, {
        getAgent: () => Effect.succeed(agent),
      } as unknown as AgentService),
    );
    const execution = runUnattendedTurn({
      agentId: agent.id,
      conversationId: "conversation",
      prompt: "Check and report the build result",
      fallbackTitle: "Build",
      source: "wake trigger",
      sourceId: "wake",
    }).pipe(Effect.provide(services)) as unknown as Effect.Effect<DeliveryOutcome>;
    const outcome = await Effect.runPromise(execution);
    await Effect.runPromise(settleWakeTrigger(directory, agent.id, "wake", outcome));
    return {
      outcome,
      remaining: await Effect.runPromise(
        readStateFile(file, WAKE_TRIGGER_STORE.kind, { onCorrupt: "fail" }),
      ),
    };
  }

  it.each(["stop", "content-filter"] as const)(
    "retains %s unusable answers for retry",
    async (finishReason) => {
      response = {
        ...response,
        finishReason,
        ...(finishReason === "content-filter"
          ? { content: "withheld", emptyCompletion: false }
          : {}),
      };
      const { outcome, remaining } = await deliver();
      expect(outcome.delivered).toBe(false);
      expect(remaining).toHaveLength(1);
      expect(remaining?.[0]?.delivery).toMatchObject({ status: "failed", attempts: 1 });
      expect(
        remaining?.[0]?.delivery?.status === "failed" && remaining[0].delivery.nextAttemptAt,
      ).toBeGreaterThan(Date.now());
    },
  );

  it("still delivers an intentionally partial budget result", async () => {
    response = { ...response, costCapped: true };
    const { outcome, remaining } = await deliver();
    expect(outcome).toEqual({ delivered: true });
    expect(remaining).toEqual([]);
  });

  it("keeps a persisted approval park delivered without restarting the turn", async () => {
    runner.mockImplementation(() =>
      Effect.fail(
        new RunParkRequested({
          runId: "parked-run",
          pending: {
            kind: "tool-approval",
            request: {
              toolCallId: "call-1",
              toolName: "execute_command",
              message: "Command: git status",
              executeToolName: "execute_execute_command",
              executeArgs: {},
            },
          },
          messages: [],
        }),
      ),
    );
    const { outcome, remaining } = await deliver();
    expect(outcome).toEqual({ delivered: true });
    expect(remaining).toEqual([]);
  });
});
