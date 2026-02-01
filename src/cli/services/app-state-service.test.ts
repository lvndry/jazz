import { describe, expect, test, beforeEach } from "bun:test";
import { Effect } from "effect";
import {
  AppStateServiceTag,
  AppStateServiceLive,
  createLogEntry,
  type AppStateService,
} from "./app-state-service";

// ============================================================================
// Tests
// ============================================================================

describe("AppStateService", () => {
  const runWithService = <A, E>(
    program: Effect.Effect<A, E, AppStateService>,
  ): Promise<A> => {
    return Effect.runPromise(Effect.provide(program, AppStateServiceLive));
  };

  describe("Log Management", () => {
    test("addLog adds a log entry", async () => {
      const result = await runWithService(
        Effect.gen(function* () {
          const service = yield* AppStateServiceTag;
          const entry = createLogEntry("log", "Test message");
          yield* service.addLog(entry);
          const logs = yield* service.getLogs;
          return logs;
        }),
      );

      expect(result).toHaveLength(1);
      expect(result[0].message).toBe("Test message");
      expect(result[0].type).toBe("log");
    });

    test("addLog appends to existing logs", async () => {
      const result = await runWithService(
        Effect.gen(function* () {
          const service = yield* AppStateServiceTag;
          yield* service.addLog(createLogEntry("log", "First"));
          yield* service.addLog(createLogEntry("log", "Second"));
          const logs = yield* service.getLogs;
          return logs;
        }),
      );

      expect(result).toHaveLength(2);
      expect(result[0].message).toBe("First");
      expect(result[1].message).toBe("Second");
    });

    test("updateLog modifies existing log by id", async () => {
      const result = await runWithService(
        Effect.gen(function* () {
          const service = yield* AppStateServiceTag;
          const id = yield* service.addLog(createLogEntry("log", "Original"));
          yield* service.updateLog(id, { message: "Updated" });
          const logs = yield* service.getLogs;
          return logs;
        }),
      );

      expect(result[0].message).toBe("Updated");
    });

    test("clearLogs removes all logs", async () => {
      const result = await runWithService(
        Effect.gen(function* () {
          const service = yield* AppStateServiceTag;
          yield* service.addLog(createLogEntry("log", "One"));
          yield* service.addLog(createLogEntry("log", "Two"));
          yield* service.clearLogs;
          const logs = yield* service.getLogs;
          return logs;
        }),
      );

      expect(result).toHaveLength(0);
    });
  });

  describe("Prompt Management", () => {
    test("setPrompt updates the prompt", async () => {
      const promptState = {
        type: "text" as const,
        message: "Enter your name",
        resolve: () => {},
      };

      const result = await runWithService(
        Effect.gen(function* () {
          const service = yield* AppStateServiceTag;
          yield* service.setPrompt(promptState);
          const prompt = yield* service.getPrompt;
          return prompt;
        }),
      );

      expect(result?.message).toBe("Enter your name");
    });

    test("setPrompt can clear the prompt", async () => {
      const result = await runWithService(
        Effect.gen(function* () {
          const service = yield* AppStateServiceTag;
          yield* service.setPrompt({
            type: "text",
            message: "Test",
            resolve: () => {},
          });
          yield* service.setPrompt(null);
          const prompt = yield* service.getPrompt;
          return prompt;
        }),
      );

      expect(result).toBeNull();
    });
  });

  describe("Status Management", () => {
    test("setStatus updates the status", async () => {
      const result = await runWithService(
        Effect.gen(function* () {
          const service = yield* AppStateServiceTag;
          yield* service.setStatus("running");
          const status = yield* service.getStatus;
          return status;
        }),
      );

      expect(result).toBe("running");
    });

    test("status can be set to different values", async () => {
      await runWithService(
        Effect.gen(function* () {
          const service = yield* AppStateServiceTag;

          yield* service.setStatus("waiting");
          let status = yield* service.getStatus;
          expect(status).toBe("waiting");

          yield* service.setStatus("error");
          status = yield* service.getStatus;
          expect(status).toBe("error");

          yield* service.setStatus(null);
          status = yield* service.getStatus;
          expect(status).toBeNull();
        }),
      );
    });
  });

  describe("Stream Management", () => {
    test("setStream updates the stream state", async () => {
      const streamState = {
        agentName: "test",
        text: "Streaming...",
        reasoning: null,
      };

      const result = await runWithService(
        Effect.gen(function* () {
          const service = yield* AppStateServiceTag;
          yield* service.setStream(streamState);
          const stream = yield* service.getStream;
          return stream;
        }),
      );

      expect(result).toEqual(streamState);
    });

    test("setStream can clear the stream", async () => {
      const result = await runWithService(
        Effect.gen(function* () {
          const service = yield* AppStateServiceTag;
          yield* service.setStream({
            agentName: "test",
            text: "Test",
            reasoning: null,
          });
          yield* service.setStream(null);
          const stream = yield* service.getStream;
          return stream;
        }),
      );

      expect(result).toBeNull();
    });
  });

  describe("Working Directory", () => {
    test("setWorkingDirectory updates the directory", async () => {
      const result = await runWithService(
        Effect.gen(function* () {
          const service = yield* AppStateServiceTag;
          yield* service.setWorkingDirectory("/new/path");
          const wd = yield* service.getWorkingDirectory;
          return wd;
        }),
      );

      expect(result).toBe("/new/path");
    });
  });

  describe("Custom View", () => {
    test("setCustomView updates the custom view", async () => {
      const customView = { type: "custom", component: "MyComponent" };

      const result = await runWithService(
        Effect.gen(function* () {
          const service = yield* AppStateServiceTag;
          yield* service.setCustomView(customView);
          const cv = yield* service.getCustomView;
          return cv;
        }),
      );

      expect(result).toEqual(customView);
    });

    test("setCustomView can clear the view", async () => {
      const result = await runWithService(
        Effect.gen(function* () {
          const service = yield* AppStateServiceTag;
          yield* service.setCustomView({ type: "test" });
          yield* service.setCustomView(null);
          const cv = yield* service.getCustomView;
          return cv;
        }),
      );

      expect(result).toBeNull();
    });
  });

  describe("Interrupt Handler", () => {
    test("setInterruptHandler stores the handler", async () => {
      const handler = () => {};

      const result = await runWithService(
        Effect.gen(function* () {
          const service = yield* AppStateServiceTag;
          yield* service.setInterruptHandler(handler);
          const storedHandler = yield* service.getInterruptHandler;
          return storedHandler;
        }),
      );

      expect(result).toBe(handler);
    });

    test("triggerInterrupt calls the handler", async () => {
      let called = false;
      const handler = () => {
        called = true;
      };

      await runWithService(
        Effect.gen(function* () {
          const service = yield* AppStateServiceTag;
          yield* service.setInterruptHandler(handler);
          yield* service.triggerInterrupt;
        }),
      );

      expect(called).toBe(true);
    });

    test("triggerInterrupt does nothing without handler", async () => {
      // Should not throw
      await runWithService(
        Effect.gen(function* () {
          const service = yield* AppStateServiceTag;
          yield* service.triggerInterrupt;
        }),
      );
    });
  });

  describe("createLogEntry Helper", () => {
    test("creates log entry with defaults", () => {
      const entry = createLogEntry("log", "Test");

      expect(entry.type).toBe("log");
      expect(entry.message).toBe("Test");
      expect(entry.timestamp).toBeInstanceOf(Date);
    });

    test("creates different types of log entries", () => {
      const logEntry = createLogEntry("log", "Log");
      const userEntry = createLogEntry("user", "User");
      const assistantEntry = createLogEntry("assistant", "Assistant");
      const toolEntry = createLogEntry("tool_call", "Tool");

      expect(logEntry.type).toBe("log");
      expect(userEntry.type).toBe("user");
      expect(assistantEntry.type).toBe("assistant");
      expect(toolEntry.type).toBe("tool_call");
    });
  });
});
