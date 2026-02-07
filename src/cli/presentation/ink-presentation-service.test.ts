import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Effect } from "effect";
import { InkStreamingRenderer } from "./ink-presentation-service";
import type { ActivityState } from "../ui/activity-state";
import { store } from "../ui/store";
import type { LogEntryInput } from "../ui/types";

describe("InkStreamingRenderer", () => {
  const setActivityCalls: ActivityState[] = [];
  const printOutputCalls: LogEntryInput[] = [];
  let originalSetActivity: (typeof store)["setActivity"];
  let originalPrintOutput: (typeof store)["printOutput"];

  function createRenderer() {
    return new InkStreamingRenderer("TestAgent", false, {
      showThinking: true,
      showToolExecution: true,
      mode: "rendered",
      colorProfile: "full",
    });
  }

  function emitStreamStart(renderer: InkStreamingRenderer) {
    Effect.runSync(renderer.handleEvent({
      type: "stream_start",
      provider: "test",
      model: "test",
      timestamp: Date.now(),
    }));
  }

  beforeEach(() => {
    setActivityCalls.length = 0;
    printOutputCalls.length = 0;
    originalSetActivity = store.setActivity;
    originalPrintOutput = store.printOutput;
    store.setActivity = (next: ActivityState) => {
      setActivityCalls.push(next);
      originalSetActivity(next);
    };
    store.printOutput = (entry: LogEntryInput) => {
      printOutputCalls.push(entry);
      return originalPrintOutput(entry);
    };
  });

  afterEach(() => {
    store.setActivity = originalSetActivity;
    store.printOutput = originalPrintOutput;
  });

  describe("out-of-order text_chunk events", () => {
    test("ignores stale chunks and keeps text from highest sequence", async () => {
      const renderer = createRenderer();
      emitStreamStart(renderer);
      Effect.runSync(renderer.handleEvent({ type: "text_start" }));

      // Deliver text_chunk events out of order: seq 2, then 1, then 3
      Effect.runSync(renderer.handleEvent({
        type: "text_chunk",
        delta: "He",
        accumulated: "He",
        sequence: 2,
      }));
      Effect.runSync(renderer.handleEvent({
        type: "text_chunk",
        delta: "H",
        accumulated: "H",
        sequence: 1,
      }));
      Effect.runSync(renderer.handleEvent({
        type: "text_chunk",
        delta: "llo",
        accumulated: "Hello",
        sequence: 3,
      }));

      // Throttle is 30ms; wait for pending update to flush
      await new Promise((r) => setTimeout(r, 60));

      const withText = setActivityCalls.filter(
        (s): s is Extract<ActivityState, { phase: "streaming" }> =>
          s.phase === "streaming" && s.text.length > 0,
      );
      expect(withText.length).toBeGreaterThan(0);
      expect(withText[withText.length - 1]!.text).toBe("Hello");
    });

    test("never overwrites with older sequence when chunks arrive out of order", async () => {
      const renderer = createRenderer();
      emitStreamStart(renderer);
      Effect.runSync(renderer.handleEvent({ type: "text_start" }));

      // Newer first, then older (stale) – should keep "Hel", not revert to "H"
      Effect.runSync(renderer.handleEvent({
        type: "text_chunk",
        delta: "Hel",
        accumulated: "Hel",
        sequence: 2,
      }));
      Effect.runSync(renderer.handleEvent({
        type: "text_chunk",
        delta: "H",
        accumulated: "H",
        sequence: 1,
      }));

      await new Promise((r) => setTimeout(r, 60));

      const withText = setActivityCalls.filter(
        (s): s is Extract<ActivityState, { phase: "streaming" }> =>
          s.phase === "streaming" && s.text.length > 0,
      );
      expect(withText.length).toBeGreaterThan(0);
      expect(withText[withText.length - 1]!.text).toBe("Hel");
    });
  });

  describe("thinking phase", () => {
    test("thinking_start transitions to thinking activity", async () => {
      const renderer = createRenderer();
      emitStreamStart(renderer);

      Effect.runSync(renderer.handleEvent({ type: "thinking_start", provider: "test" }));
      await new Promise((r) => setTimeout(r, 60));

      const thinking = setActivityCalls.filter((s) => s.phase === "thinking");
      expect(thinking.length).toBeGreaterThan(0);
    });

    test("thinking_chunk updates reasoning in activity", async () => {
      const renderer = createRenderer();
      emitStreamStart(renderer);

      Effect.runSync(renderer.handleEvent({ type: "thinking_start", provider: "test" }));
      Effect.runSync(renderer.handleEvent({ type: "thinking_chunk", content: "let me think", sequence: 0 }));
      await new Promise((r) => setTimeout(r, 60));

      const thinking = setActivityCalls.filter(
        (s): s is Extract<ActivityState, { phase: "thinking" }> => s.phase === "thinking",
      );
      const last = thinking[thinking.length - 1];
      expect(last).toBeDefined();
      expect(last!.reasoning.length).toBeGreaterThan(0);
    });
  });

  describe("tool execution phase", () => {
    test("tool_execution_start transitions to tool-execution activity", async () => {
      const renderer = createRenderer();
      emitStreamStart(renderer);

      Effect.runSync(renderer.handleEvent({
        type: "tool_execution_start",
        toolName: "execute_bash",
        toolCallId: "tc-1",
        arguments: { command: "ls" },
      }));
      await new Promise((r) => setTimeout(r, 60));

      const toolPhases = setActivityCalls.filter(
        (s): s is Extract<ActivityState, { phase: "tool-execution" }> => s.phase === "tool-execution",
      );
      expect(toolPhases.length).toBeGreaterThan(0);
      expect(toolPhases[0]!.tools[0]!.toolName).toBe("execute_bash");
    });

    test("tool_execution_complete transitions back to idle when last tool", async () => {
      const renderer = createRenderer();
      emitStreamStart(renderer);

      Effect.runSync(renderer.handleEvent({
        type: "tool_execution_start",
        toolName: "execute_bash",
        toolCallId: "tc-1",
      }));
      Effect.runSync(renderer.handleEvent({
        type: "tool_execution_complete",
        toolCallId: "tc-1",
        result: "done",
        durationMs: 50,
      }));
      await new Promise((r) => setTimeout(r, 60));

      const last = setActivityCalls[setActivityCalls.length - 1];
      expect(last!.phase).toBe("idle");
    });
  });

  describe("complete phase", () => {
    test("prints response to Static before clearing activity to idle", async () => {
      const renderer = createRenderer();
      emitStreamStart(renderer);

      Effect.runSync(renderer.handleEvent({ type: "text_start" }));
      Effect.runSync(renderer.handleEvent({
        type: "text_chunk",
        delta: "Hello world",
        accumulated: "Hello world",
        sequence: 0,
      }));
      await new Promise((r) => setTimeout(r, 60));

      // Record the order of calls
      const callOrder: string[] = [];
      const origActivity = store.setActivity;
      const origPrint = store.printOutput;
      store.setActivity = (next: ActivityState) => {
        callOrder.push(`activity:${next.phase}`);
        origActivity(next);
      };
      store.printOutput = (entry: LogEntryInput) => {
        callOrder.push(`print:${entry.type}`);
        return origPrint(entry);
      };

      Effect.runSync(renderer.handleEvent({
        type: "complete",
        response: { content: "Hello world", role: "assistant", usage: undefined, toolCalls: [] },
        totalDurationMs: 100,
      }));

      store.setActivity = origActivity;
      store.printOutput = origPrint;

      // print:log (the response text) should come BEFORE activity:idle
      // to prevent a blank flash where streamed content vanishes for one frame
      const idleIdx = callOrder.indexOf("activity:idle");
      const printIdx = callOrder.indexOf("print:log");
      expect(idleIdx).toBeGreaterThanOrEqual(0);
      expect(printIdx).toBeGreaterThanOrEqual(0);
      expect(printIdx).toBeLessThan(idleIdx);
    });

    test("does not use AgentResponseCard when streaming was active", () => {
      const renderer = createRenderer();
      emitStreamStart(renderer);

      Effect.runSync(renderer.handleEvent({ type: "text_start" }));
      Effect.runSync(renderer.handleEvent({
        type: "text_chunk",
        delta: "response",
        accumulated: "response",
        sequence: 0,
      }));

      printOutputCalls.length = 0;

      Effect.runSync(renderer.handleEvent({
        type: "complete",
        response: { content: "response", role: "assistant", usage: undefined, toolCalls: [] },
        totalDurationMs: 50,
      }));

      // The response should be printed as a plain log, not as an ink node (AgentResponseCard)
      const responseLogs = printOutputCalls.filter((e) => e.type === "log" && e.message === "response");
      expect(responseLogs.length).toBeGreaterThan(0);
      // Verify it's a string, not a TerminalInkNode
      expect(typeof responseLogs[0]!.message).toBe("string");
    });
  });

  describe("reset", () => {
    test("clears activity to idle", () => {
      const renderer = createRenderer();
      emitStreamStart(renderer);
      Effect.runSync(renderer.reset());

      const last = setActivityCalls[setActivityCalls.length - 1];
      expect(last!.phase).toBe("idle");
    });
  });

  describe("flush", () => {
    test("flushes live text to log and clears activity", () => {
      const renderer = createRenderer();
      emitStreamStart(renderer);

      Effect.runSync(renderer.handleEvent({ type: "text_start" }));
      Effect.runSync(renderer.handleEvent({
        type: "text_chunk",
        delta: "partial",
        accumulated: "partial",
        sequence: 0,
      }));

      printOutputCalls.length = 0;
      Effect.runSync(renderer.flush());

      // Should have flushed the text to a log entry
      const textLogs = printOutputCalls.filter(
        (e) => e.type === "log" && typeof e.message === "string" && e.message.includes("partial"),
      );
      expect(textLogs.length).toBeGreaterThan(0);

      // Should have set activity to idle
      const last = setActivityCalls[setActivityCalls.length - 1];
      expect(last!.phase).toBe("idle");
    });
  });
});
