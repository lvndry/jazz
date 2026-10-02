/**
 * The OS scheduler fires a wake trigger in a fresh process with no daemon. A turn that parks for
 * an approval saves itself in the run store, so the command must provide one.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { WAKE_TRIGGER_STORE } from "@jazz/adapters/wake-trigger-service";
import { AgentRunner } from "@jazz/core/agent/agent-runner";
import { AgentConfigServiceTag, type AgentConfigService } from "@jazz/core/interfaces/agent-config";
import { AgentServiceTag, type AgentService } from "@jazz/core/interfaces/agent-service";
import { LoggerServiceTag, type LoggerService } from "@jazz/core/interfaces/logger";
import { RunStoreTag } from "@jazz/core/interfaces/run-store";
import type { Agent } from "@jazz/core/types/agent";
import { readStateFile, writeStateFile } from "@jazz/core/utils/state-file";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Effect, Layer } from "effect";
import { fireWakeTriggerCommand } from "./wake-trigger";

const agent: Agent = {
  id: "test-agent",
  name: "test-agent",
  config: { persona: "default", llm: { provider: "openai", model: "gpt-4o-mini" } },
  createdAt: new Date(0),
  updatedAt: new Date(0),
};
const logger = {
  debug: () => Effect.void,
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
} as unknown as LoggerService;

describe("fireWakeTriggerCommand", () => {
  let previousHome: string | undefined;
  let home: string;
  let runner: ReturnType<typeof spyOn<typeof AgentRunner, "run">>;
  let runStoreProvided: boolean | undefined;

  beforeEach(() => {
    previousHome = process.env["JAZZ_HOME"];
    home = mkdtempSync(join(tmpdir(), "jazz-wake-trigger-fire-"));
    process.env["JAZZ_HOME"] = home;
    runStoreProvided = undefined;
    runner = spyOn(AgentRunner, "run").mockImplementation(
      () =>
        Effect.serviceOption(RunStoreTag).pipe(
          Effect.map((runStore) => {
            runStoreProvided = runStore._tag === "Some";
            return {
              content: "done",
              conversationId: "conversation",
              finishReason: "stop" as const,
            };
          }),
        ) as never,
    );
  });
  afterEach(() => {
    runner.mockRestore();
    if (previousHome === undefined) {
      delete process.env["JAZZ_HOME"];
    } else {
      process.env["JAZZ_HOME"] = previousHome;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("runs the turn with a run store so an approval park can be saved", async () => {
    const directory = join(home, "wake-triggers");
    const file = WAKE_TRIGGER_STORE.filePath(directory, agent.id);
    await Effect.runPromise(
      writeStateFile(file, WAKE_TRIGGER_STORE.kind, [
        {
          id: "wake",
          conversationId: "conversation",
          fireAt: 0,
          createdAt: 0,
          prompt: "Check the build",
          reason: "Follow up",
        },
      ]),
    );
    const services = Layer.mergeAll(
      NodeFileSystem.layer,
      Layer.succeed(LoggerServiceTag, logger),
      Layer.succeed(AgentConfigServiceTag, {
        appConfig: Effect.succeed({}),
      } as unknown as AgentConfigService),
      Layer.succeed(AgentServiceTag, {
        getAgent: () => Effect.succeed(agent),
      } as unknown as AgentService),
    );

    await Effect.runPromise(
      fireWakeTriggerCommand({ agent: agent.id, id: "wake" }).pipe(
        Effect.provide(services),
      ) as unknown as Effect.Effect<void>,
    );

    expect(runStoreProvided).toBe(true);
    expect(
      await Effect.runPromise(readStateFile(file, WAKE_TRIGGER_STORE.kind, { onCorrupt: "fail" })),
    ).toHaveLength(0);
  });
});
