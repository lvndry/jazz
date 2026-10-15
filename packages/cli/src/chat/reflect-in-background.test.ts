/**
 * Detached reflection must retain the chat's config selection as a single argv value and
 * report a launch failure without interrupting chat shutdown. No child processes run here.
 */
import { silentLogger } from "@jazz/core/agent/test-logger";
import { LoggerServiceTag } from "@jazz/core/interfaces/logger";
import * as worker from "@jazz/core/jobs/spawn-job-worker";
import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { Effect } from "effect";
import { reflectInBackground } from "./reflect-in-background";

let launch: Mock<typeof worker.spawnDetachedJazz>;

beforeEach(() => {
  launch = spyOn(worker, "spawnDetachedJazz");
});

afterEach(() => {
  launch.mockRestore();
});

describe("reflectInBackground", () => {
  test.each([undefined, "./settings/custom config.json", "~/settings/custom.json"])(
    "preserves config selection: %s",
    async (configPath) => {
      launch.mockReturnValue(Effect.succeed({ spawned: true }));
      await Effect.runPromise(
        reflectInBackground("agent-1", "conversation-1", configPath).pipe(
          Effect.provideService(LoggerServiceTag, silentLogger),
        ),
      );
      expect(launch).toHaveBeenCalledWith([
        ...(configPath === undefined ? [] : ["--config", configPath]),
        "--output",
        "quiet",
        "memory",
        "reflect",
        "--agent",
        "agent-1",
        "--conversation",
        "conversation-1",
      ]);
    },
  );

  test("logs a launch failure", async () => {
    launch.mockReturnValue(Effect.succeed({ spawned: false, reason: "executable unavailable" }));
    const warn = spyOn(silentLogger, "warn");
    try {
      await Effect.runPromise(
        reflectInBackground("agent-1", "conversation-1", "custom.json").pipe(
          Effect.provideService(LoggerServiceTag, silentLogger),
        ),
      );
      expect(warn).toHaveBeenCalledWith("Could not start the end-of-conversation lesson pass", {
        agentId: "agent-1",
        conversationId: "conversation-1",
        reason: "executable unavailable",
      });
    } finally {
      warn.mockRestore();
    }
  });
});
