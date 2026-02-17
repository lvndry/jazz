import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Effect } from "effect";
import { InkStreamingRenderer } from "./ink-presentation-service";
import type { ActivityState } from "../ui/activity-state";
import { store } from "../ui/store";
import type { OutputEntry } from "../ui/types";

describe("InkStreamingRenderer", () => {
  const setActivityCalls: ActivityState[] = [];
  const printOutputCalls: OutputEntry[] = [];
  let originalSetActivity: (typeof store)["setActivity"];
  let originalPrintOutput: (typeof store)["printOutput"];
  let lastRenderer: InkStreamingRenderer | null = null;

  function createRenderer() {
    const renderer = new InkStreamingRenderer(
      "TestAgent",
      false,
      {
        showThinking: true,
        showToolExecution: true,
        mode: "rendered",
        colorProfile: "full",
      },
      0,
    );
    lastRenderer = renderer;
    return renderer;
  }

  function emitStreamStart(renderer: InkStreamingRenderer) {
    Effect.runSync(
      renderer.handleEvent({
        type: "stream_start",
        provider: "test",
        model: "test",
        timestamp: Date.now(),
      }),
    );
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
    store.printOutput = (entry: OutputEntry) => {
      printOutputCalls.push(entry);
      return originalPrintOutput(entry);
    };
  });

  afterEach(() => {
    if (lastRenderer) {
      Effect.runSync(lastRenderer.reset());
      lastRenderer = null;
    }
    store.setActivity = originalSetActivity;
    store.printOutput = originalPrintOutput;
  });

  describe("out-of-order text_chunk events", () => {
    test("ignores stale chunks and keeps text from highest sequence", async () => {
      const renderer = createRenderer();
      emitStreamStart(renderer);
      Effect.runSync(renderer.handleEvent({ type: "text_start" }));

      // Deliver text_chunk events out of order: seq 2, then 1, then 3
      Effect.runSync(
        renderer.handleEvent({
          type: "text_chunk",
          delta: "He",
          accumulated: "He",
          sequence: 2,
        }),
      );
      Effect.runSync(
        renderer.handleEvent({
          type: "text_chunk",
          delta: "H",
          accumulated: "H",
          sequence: 1,
        }),
      );
      Effect.runSync(
        renderer.handleEvent({
          type: "text_chunk",
          delta: "llo",
          accumulated: "Hello",
          sequence: 3,
        }),
      );

      // Wait for pending throttled update to flush
      await new Promise((r) => setTimeout(r, 0));

      // Short text stays in the live area (activity.text), not flushed to Static.
      // The final activity should contain the correctly assembled "Hello".
      const streaming = setActivityCalls.filter(
        (s): s is Extract<(typeof setActivityCalls)[number], { phase: "streaming" }> =>
          s.phase === "streaming",
      );
      expect(streaming.length).toBeGreaterThan(0);
      const lastText = streaming[streaming.length - 1]!.text;
      expect(lastText).toContain("Hello");
    });

    test("never overwrites with older sequence when chunks arrive out of order", async () => {
      const renderer = createRenderer();
      emitStreamStart(renderer);
      Effect.runSync(renderer.handleEvent({ type: "text_start" }));

      // Newer first, then older (stale) – should keep "Hel", not revert to "H"
      Effect.runSync(
        renderer.handleEvent({
          type: "text_chunk",
          delta: "Hel",
          accumulated: "Hel",
          sequence: 2,
        }),
      );
      Effect.runSync(
        renderer.handleEvent({
          type: "text_chunk",
          delta: "H",
          accumulated: "H",
          sequence: 1,
        }),
      );

      await new Promise((r) => setTimeout(r, 0));

      // Live area text should contain "Hel" (the newer sequence),
      // and should NOT have been reverted to "H".
      const streaming = setActivityCalls.filter(
        (s): s is Extract<(typeof setActivityCalls)[number], { phase: "streaming" }> =>
          s.phase === "streaming",
      );
      expect(streaming.length).toBeGreaterThan(0);
      expect(streaming[streaming.length - 1]!.text).toContain("Hel");
    });
  });

  describe("thinking phase", () => {
    test("thinking_start transitions to thinking activity", async () => {
      const renderer = createRenderer();
      emitStreamStart(renderer);

      Effect.runSync(renderer.handleEvent({ type: "thinking_start", provider: "test" }));
      await new Promise((r) => setTimeout(r, 0));

      const thinking = setActivityCalls.filter((s) => s.phase === "thinking");
      expect(thinking.length).toBeGreaterThan(0);
    });

    test("thinking_chunk updates reasoning in activity", async () => {
      const renderer = createRenderer();
      emitStreamStart(renderer);

      Effect.runSync(renderer.handleEvent({ type: "thinking_start", provider: "test" }));
      Effect.runSync(
        renderer.handleEvent({ type: "thinking_chunk", content: "let me think", sequence: 0 }),
      );
      await new Promise((r) => setTimeout(r, 0));

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

      Effect.runSync(
        renderer.handleEvent({
          type: "tool_execution_start",
          toolName: "execute_bash",
          toolCallId: "tc-1",
          arguments: { command: "ls" },
        }),
      );
      await new Promise((r) => setTimeout(r, 0));

      const toolPhases = setActivityCalls.filter(
        (s): s is Extract<ActivityState, { phase: "tool-execution" }> =>
          s.phase === "tool-execution",
      );
      expect(toolPhases.length).toBeGreaterThan(0);
      expect(toolPhases[0]!.tools[0]!.toolName).toBe("execute_bash");
    });

    test("tool_execution_complete transitions back to idle when last tool", async () => {
      const renderer = createRenderer();
      emitStreamStart(renderer);

      Effect.runSync(
        renderer.handleEvent({
          type: "tool_execution_start",
          toolName: "execute_bash",
          toolCallId: "tc-1",
        }),
      );
      Effect.runSync(
        renderer.handleEvent({
          type: "tool_execution_complete",
          toolCallId: "tc-1",
          result: "done",
          durationMs: 50,
        }),
      );
      await new Promise((r) => setTimeout(r, 0));

      const last = setActivityCalls[setActivityCalls.length - 1];
      expect(last!.phase).toBe("idle");
    });
  });

  describe("complete phase", () => {
    test("prints response to Static before clearing activity to idle", async () => {
      const renderer = createRenderer();
      emitStreamStart(renderer);

      Effect.runSync(renderer.handleEvent({ type: "text_start" }));
      Effect.runSync(
        renderer.handleEvent({
          type: "text_chunk",
          delta: "Hello world",
          accumulated: "Hello world",
          sequence: 0,
        }),
      );
      await new Promise((r) => setTimeout(r, 0));

      // Record the order of calls
      const callOrder: string[] = [];
      const origActivity = store.setActivity;
      const origPrint = store.printOutput;
      store.setActivity = (next: ActivityState) => {
        callOrder.push(`activity:${next.phase}`);
        origActivity(next);
      };
      store.printOutput = (entry: OutputEntry) => {
        callOrder.push(`print:${entry.type}`);
        return origPrint(entry);
      };

      Effect.runSync(
        renderer.handleEvent({
          type: "complete",
          response: { content: "Hello world", role: "assistant", usage: undefined, toolCalls: [] },
          totalDurationMs: 100,
        }),
      );

      store.setActivity = origActivity;
      store.printOutput = origPrint;

      // print:streamContent (the response text) should come BEFORE activity:idle
      // to prevent a blank flash where streamed content vanishes for one frame
      const idleIdx = callOrder.indexOf("activity:idle");
      const printIdx = callOrder.indexOf("print:streamContent");
      expect(idleIdx).toBeGreaterThanOrEqual(0);
      expect(printIdx).toBeGreaterThanOrEqual(0);
      expect(printIdx).toBeLessThan(idleIdx);
    });

    test("does not use AgentResponseCard when streaming was active", () => {
      const renderer = createRenderer();
      emitStreamStart(renderer);

      Effect.runSync(renderer.handleEvent({ type: "text_start" }));
      Effect.runSync(
        renderer.handleEvent({
          type: "text_chunk",
          delta: "response",
          accumulated: "response",
          sequence: 0,
        }),
      );

      printOutputCalls.length = 0;

      Effect.runSync(
        renderer.handleEvent({
          type: "complete",
          response: { content: "response", role: "assistant", usage: undefined, toolCalls: [] },
          totalDurationMs: 50,
        }),
      );

      // The response should be printed as a pre-padded plain string (not AgentResponseCard/Ink node)
      const responseLogs = printOutputCalls.filter((e) => e.type === "streamContent");
      expect(responseLogs.length).toBeGreaterThan(0);
      const msg = responseLogs[0]!.message;
      expect(typeof msg).toBe("string");
    });
  });

  describe("throttle behavior", () => {
    test("latest activity wins when multiple arrive within throttle window", async () => {
      const renderer = createRenderer();
      emitStreamStart(renderer);
      Effect.runSync(renderer.handleEvent({ type: "text_start" }));

      // Fire 3 text_chunks rapidly — all within 30ms throttle window
      Effect.runSync(
        renderer.handleEvent({
          type: "text_chunk",
          delta: "A",
          accumulated: "A",
          sequence: 0,
        }),
      );
      Effect.runSync(
        renderer.handleEvent({
          type: "text_chunk",
          delta: "B",
          accumulated: "AB",
          sequence: 1,
        }),
      );
      Effect.runSync(
        renderer.handleEvent({
          type: "text_chunk",
          delta: "C",
          accumulated: "ABC",
          sequence: 2,
        }),
      );

      // Wait for throttle to flush
      await new Promise((r) => setTimeout(r, 0));

      // Short text stays in the live area (activity.text).
      // The latest activity should contain all accumulated text.
      const streaming = setActivityCalls.filter(
        (s): s is Extract<(typeof setActivityCalls)[number], { phase: "streaming" }> =>
          s.phase === "streaming",
      );
      expect(streaming.length).toBeGreaterThan(0);
      const lastText = streaming[streaming.length - 1]!.text;
      expect(lastText).toContain("ABC");
    });
  });

  describe("non-streaming complete (fallback path)", () => {
    test("uses AgentResponseCard when no stream_start was emitted", () => {
      // Create renderer without emitting stream_start — simulates non-streaming response
      const renderer = createRenderer();

      printOutputCalls.length = 0;

      Effect.runSync(
        renderer.handleEvent({
          type: "complete",
          response: {
            content: "Non-streamed answer",
            role: "assistant",
            usage: undefined,
            toolCalls: [],
          },
          totalDurationMs: 50,
        }),
      );

      // Should emit an info entry (agent name header) followed by a log entry (response card)
      const infoEntries = printOutputCalls.filter((e) => e.type === "info");
      const logEntries = printOutputCalls.filter((e) => e.type === "log");
      expect(infoEntries.length).toBeGreaterThan(0);
      expect(logEntries.length).toBeGreaterThan(0);

      // The log entry should be an Ink node (AgentResponseCard)
      const responseEntry = logEntries[0]!;
      const msg = responseEntry.message;
      if (typeof msg === "object" && msg !== null && "_tag" in msg) {
        expect(msg._tag).toBe("ink");
      }
    });

    test("does not print when response content is empty", () => {
      const renderer = createRenderer();

      printOutputCalls.length = 0;

      Effect.runSync(
        renderer.handleEvent({
          type: "complete",
          response: { content: "", role: "assistant", usage: undefined, toolCalls: [] },
          totalDurationMs: 50,
        }),
      );

      // No info or log entries for the response body (only activity:idle)
      const contentEntries = printOutputCalls.filter(
        (e) => (e.type === "info" || e.type === "log") && e.message !== "",
      );
      expect(contentEntries).toHaveLength(0);
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
    test("flush() promotes unflushed text to Static and clears activity", () => {
      const renderer = createRenderer();
      emitStreamStart(renderer);

      Effect.runSync(renderer.handleEvent({ type: "text_start" }));
      Effect.runSync(
        renderer.handleEvent({
          type: "text_chunk",
          delta: "partial",
          accumulated: "partial",
          sequence: 0,
        }),
      );

      // Short text stays in live area during streaming (no streamContent yet)
      const beforeFlush = printOutputCalls.filter(
        (e) =>
          e.type === "streamContent" &&
          typeof e.message === "string" &&
          e.message.includes("partial"),
      );
      expect(beforeFlush.length).toBe(0);

      // flush() promotes the text to Static and sets activity to idle
      Effect.runSync(renderer.flush());
      const afterFlush = printOutputCalls.filter(
        (e) =>
          e.type === "streamContent" &&
          typeof e.message === "string" &&
          e.message.includes("partial"),
      );
      expect(afterFlush.length).toBeGreaterThan(0);

      const last = setActivityCalls[setActivityCalls.length - 1];
      expect(last!.phase).toBe("idle");
    });
  });

  describe("Static flush behavior", () => {
    test("short text stays in live area during streaming", async () => {
      const renderer = createRenderer();
      emitStreamStart(renderer);
      Effect.runSync(renderer.handleEvent({ type: "text_start" }));

      const longLine = "word ".repeat(40).trim();
      Effect.runSync(
        renderer.handleEvent({
          type: "text_chunk",
          delta: longLine,
          accumulated: longLine,
          sequence: 0,
        }),
      );

      await new Promise((r) => setTimeout(r, 0));

      // Short text stays in the live area (activity.text)
      const streaming = setActivityCalls.filter(
        (s): s is Extract<ActivityState, { phase: "streaming" }> => s.phase === "streaming",
      );
      expect(streaming.length).toBeGreaterThan(0);
      expect(streaming[streaming.length - 1]!.text).toContain("word");
    });

    test("short text appears in activity.text for live area display", async () => {
      const renderer = createRenderer();
      emitStreamStart(renderer);
      Effect.runSync(renderer.handleEvent({ type: "text_start" }));

      const shortText = "Hello world";
      Effect.runSync(
        renderer.handleEvent({
          type: "text_chunk",
          delta: shortText,
          accumulated: shortText,
          sequence: 0,
        }),
      );

      await new Promise((r) => setTimeout(r, 0));

      // Short text stays in live area, not flushed to Static
      const streaming = setActivityCalls.filter(
        (s): s is Extract<ActivityState, { phase: "streaming" }> => s.phase === "streaming",
      );
      expect(streaming.length).toBeGreaterThan(0);
      expect(streaming[streaming.length - 1]!.text).toContain("Hello");
    });

    test("final response on complete transitions to idle", () => {
      const renderer = createRenderer();
      emitStreamStart(renderer);
      Effect.runSync(renderer.handleEvent({ type: "text_start" }));

      const longLine = "word ".repeat(40).trim();
      Effect.runSync(
        renderer.handleEvent({
          type: "text_chunk",
          delta: longLine,
          accumulated: longLine,
          sequence: 0,
        }),
      );

      printOutputCalls.length = 0;

      Effect.runSync(
        renderer.handleEvent({
          type: "complete",
          response: { content: longLine, role: "assistant", usage: undefined, toolCalls: [] },
          totalDurationMs: 50,
        }),
      );

      // Complete should transition to idle
      const last = setActivityCalls[setActivityCalls.length - 1];
      expect(last!.phase).toBe("idle");
    });
  });

  // -------------------------------------------------------------------------
  // CRITICAL REGRESSION TESTS: no streamContent during streaming
  // -------------------------------------------------------------------------
  // These tests guard the invariant at the renderer level: during streaming,
  // text_chunk events must NEVER trigger printOutput with streamContent entries.
  // If they do, each token becomes a separate <Box> in Ink's Static region,
  // causing one-word-per-line rendering.
  // -------------------------------------------------------------------------

  describe("no streamContent output during streaming (regression)", () => {
    test("text_chunk events never trigger printOutput with streamContent", async () => {
      const renderer = createRenderer();
      emitStreamStart(renderer);
      Effect.runSync(renderer.handleEvent({ type: "text_start" }));

      // Clear any outputs from text_start
      printOutputCalls.length = 0;

      // Simulate 20 tokens arriving rapidly
      let accumulated = "";
      for (let i = 0; i < 20; i++) {
        const token = `word${i} `;
        accumulated += token;
        Effect.runSync(
          renderer.handleEvent({
            type: "text_chunk",
            delta: token,
            accumulated,
            sequence: i,
          }),
        );
      }

      await new Promise((r) => setTimeout(r, 0));

      // ZERO streamContent entries during streaming
      const streamContentDuringStreaming = printOutputCalls.filter(
        (e) => e.type === "streamContent",
      );
      expect(streamContentDuringStreaming).toHaveLength(0);

      // But text SHOULD be in the activity (live area)
      const streaming = setActivityCalls.filter(
        (s): s is Extract<ActivityState, { phase: "streaming" }> => s.phase === "streaming",
      );
      expect(streaming.length).toBeGreaterThan(0);
      expect(streaming[streaming.length - 1]!.text).toContain("word19");
    });

    test("long text never triggers streamContent during streaming", async () => {
      const renderer = createRenderer();
      emitStreamStart(renderer);
      Effect.runSync(renderer.handleEvent({ type: "text_start" }));

      printOutputCalls.length = 0;

      // Send a very large text chunk (would previously trigger flush)
      const bigText = "paragraph ".repeat(500).trim();
      Effect.runSync(
        renderer.handleEvent({
          type: "text_chunk",
          delta: bigText,
          accumulated: bigText,
          sequence: 0,
        }),
      );

      await new Promise((r) => setTimeout(r, 0));

      const streamContentEntries = printOutputCalls.filter((e) => e.type === "streamContent");
      expect(streamContentEntries).toHaveLength(0);
    });

    test("on complete, exactly one streamContent entry is printed for the full response", () => {
      const renderer = createRenderer();
      emitStreamStart(renderer);
      Effect.runSync(renderer.handleEvent({ type: "text_start" }));

      // Stream multiple chunks
      let accumulated = "";
      for (let i = 0; i < 10; i++) {
        const token = `sentence${i}. `;
        accumulated += token;
        Effect.runSync(
          renderer.handleEvent({
            type: "text_chunk",
            delta: token,
            accumulated,
            sequence: i,
          }),
        );
      }

      // Clear all outputs from streaming phase
      printOutputCalls.length = 0;

      // Complete the stream
      Effect.runSync(
        renderer.handleEvent({
          type: "complete",
          response: {
            content: accumulated,
            role: "assistant",
            usage: undefined,
            toolCalls: [],
          },
          totalDurationMs: 100,
        }),
      );

      // Exactly ONE streamContent entry for the full response
      const streamContentEntries = printOutputCalls.filter((e) => e.type === "streamContent");
      expect(streamContentEntries).toHaveLength(1);

      // And it should contain the full text
      const msg = streamContentEntries[0]!.message;
      expect(typeof msg).toBe("string");
      expect(msg as string).toContain("sentence0");
      expect(msg as string).toContain("sentence9");
    });

    test("only setActivity is called during streaming, never printOutput for text", async () => {
      const renderer = createRenderer();
      emitStreamStart(renderer);
      Effect.runSync(renderer.handleEvent({ type: "text_start" }));

      // Record call order after text_start
      const callOrder: ("setActivity" | "printOutput:streamContent")[] = [];
      const origActivity = store.setActivity;
      const origPrint = store.printOutput;
      store.setActivity = (next: ActivityState) => {
        if (next.phase === "streaming") callOrder.push("setActivity");
        origActivity(next);
      };
      store.printOutput = (entry: OutputEntry) => {
        if (entry.type === "streamContent") callOrder.push("printOutput:streamContent");
        return origPrint(entry);
      };

      // Stream 15 tokens
      let accumulated = "";
      for (let i = 0; i < 15; i++) {
        const token = `t${i} `;
        accumulated += token;
        Effect.runSync(
          renderer.handleEvent({
            type: "text_chunk",
            delta: token,
            accumulated,
            sequence: i,
          }),
        );
      }

      await new Promise((r) => setTimeout(r, 0));

      store.setActivity = origActivity;
      store.printOutput = origPrint;

      // During streaming: setActivity should be called, printOutput:streamContent should NOT
      expect(callOrder.filter((c) => c === "setActivity").length).toBeGreaterThan(0);
      expect(callOrder.filter((c) => c === "printOutput:streamContent").length).toBe(0);
    });
  });
});
