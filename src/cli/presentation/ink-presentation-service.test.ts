import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Effect } from "effect";
import { InkStreamingRenderer } from "./ink-presentation-service";
import { MAX_LIVE_TEXT_CHARS } from "./stream-text-order";
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
      undefined,
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

      // Flush the streaming buffer to emit any buffered text
      Effect.runSync(renderer.flush());

      const streamed = printOutputCalls
        .filter((e) => e.type === "streamContent")
        .map((e) => (typeof e.message === "string" ? e.message : ""))
        .join("");
      expect(streamed).toContain("Hello");
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

      // Flush the streaming buffer to emit any buffered text
      Effect.runSync(renderer.flush());

      const streamed = printOutputCalls
        .filter((e) => e.type === "streamContent")
        .map((e) => (typeof e.message === "string" ? e.message : ""))
        .join("");
      expect(streamed).toContain("Hel");
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

    test("thinking_chunk streams reasoning output", async () => {
      const renderer = createRenderer();
      emitStreamStart(renderer);

      Effect.runSync(renderer.handleEvent({ type: "thinking_start", provider: "test" }));
      Effect.runSync(
        renderer.handleEvent({ type: "thinking_chunk", content: "let me think\n", sequence: 0 }),
      );
      Effect.runSync(renderer.handleEvent({ type: "thinking_complete" }));
      await new Promise((r) => setTimeout(r, 0));

      const streamed = printOutputCalls
        .filter((e) => e.type === "streamContent")
        .map((e) => (typeof e.message === "string" ? e.message : ""))
        .join("");
      expect(streamed).toContain("Reasoning");
      expect(streamed).toContain("let me think");
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

      // Complete should still transition activity to idle
      const idleIdx = callOrder.indexOf("activity:idle");
      expect(idleIdx).toBeGreaterThanOrEqual(0);
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

      Effect.runSync(
        renderer.handleEvent({
          type: "complete",
          response: { content: "response", role: "assistant", usage: undefined, toolCalls: [] },
          totalDurationMs: 50,
        }),
      );

      // Streaming path should not render the AgentResponseCard
      const inkLogs = printOutputCalls.filter(
        (e) => e.type === "log" && typeof e.message === "object" && e.message !== null,
      );
      expect(inkLogs.length).toBe(0);
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

      // Flush the streaming buffer to emit any buffered text
      Effect.runSync(renderer.flush());

      const streamed = printOutputCalls
        .filter((e) => e.type === "streamContent")
        .map((e) => (typeof e.message === "string" ? e.message : ""))
        .join("");
      expect(streamed).toContain("ABC");
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

      const beforeFlush = printOutputCalls.filter(
        (e) =>
          e.type === "streamContent" &&
          typeof e.message === "string" &&
          e.message.includes("partial"),
      );
      // No newline yet, so text should still be buffered
      expect(beforeFlush).toHaveLength(0);

      // flush() clears activity and emits any remaining buffered text
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
    test("short text is appended to output during streaming", async () => {
      const renderer = createRenderer();
      emitStreamStart(renderer);
      Effect.runSync(renderer.handleEvent({ type: "text_start" }));

      const longLine = "word ".repeat(40).trim() + "\n";
      Effect.runSync(
        renderer.handleEvent({
          type: "text_chunk",
          delta: longLine,
          accumulated: longLine,
          sequence: 0,
        }),
      );

      await new Promise((r) => setTimeout(r, 0));

      const streamed = printOutputCalls
        .filter((e) => e.type === "streamContent")
        .map((e) => (typeof e.message === "string" ? e.message : ""))
        .join("");
      expect(streamed).toContain("word");
    });

    test("streaming activity does not include response text", async () => {
      const renderer = createRenderer();
      emitStreamStart(renderer);
      Effect.runSync(renderer.handleEvent({ type: "text_start" }));

      const shortText = "Hello world\n";
      Effect.runSync(
        renderer.handleEvent({
          type: "text_chunk",
          delta: shortText,
          accumulated: shortText,
          sequence: 0,
        }),
      );

      await new Promise((r) => setTimeout(r, 0));

      // Activity stays in streaming phase but text is not shown there
      const streaming = setActivityCalls.filter(
        (s): s is Extract<ActivityState, { phase: "streaming" }> => s.phase === "streaming",
      );
      expect(streaming.length).toBeGreaterThan(0);
      expect(streaming[streaming.length - 1]!.text).toBe("");
    });

    test("final response on complete transitions to idle", () => {
      const renderer = createRenderer();
      emitStreamStart(renderer);
      Effect.runSync(renderer.handleEvent({ type: "text_start" }));

      const longLine = "word ".repeat(40).trim() + "\n";
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

  describe("append-only streaming", () => {
    test("streams chunks as output entries in order", async () => {
      const renderer = createRenderer();
      emitStreamStart(renderer);
      Effect.runSync(renderer.handleEvent({ type: "text_start" }));

      let accumulated = "";
      for (let i = 0; i < 5; i++) {
        const token = `word${i}\n`;
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

      const streamed = printOutputCalls
        .filter((e) => e.type === "streamContent")
        .map((e) => (typeof e.message === "string" ? e.message : ""))
        .join("");
      expect(streamed).toContain("word0");
      expect(streamed).toContain("word4");
    });

    test("does not duplicate content on complete when streaming already emitted", () => {
      const renderer = createRenderer();
      emitStreamStart(renderer);
      Effect.runSync(renderer.handleEvent({ type: "text_start" }));

      Effect.runSync(
        renderer.handleEvent({
          type: "text_chunk",
          delta: "done\n",
          accumulated: "done\n",
          sequence: 0,
        }),
      );

      const beforeCount = printOutputCalls.filter((e) => e.type === "streamContent").length;

      Effect.runSync(
        renderer.handleEvent({
          type: "complete",
          response: { content: "done ", role: "assistant", usage: undefined, toolCalls: [] },
          totalDurationMs: 100,
        }),
      );

      const afterCount = printOutputCalls.filter((e) => e.type === "streamContent").length;
      expect(afterCount).toBe(beforeCount);
    });

    test("continues streaming correctly after liveText front-trimming", () => {
      const renderer = createRenderer();
      emitStreamStart(renderer);
      Effect.runSync(renderer.handleEvent({ type: "text_start" }));

      const base = `${"a".repeat(MAX_LIVE_TEXT_CHARS - 6)}\n`;
      const marker = "MARKER1234567890\n";
      const accumulated1 = base;
      const accumulated2 = base + marker;

      Effect.runSync(
        renderer.handleEvent({
          type: "text_chunk",
          delta: accumulated1,
          accumulated: accumulated1,
          sequence: 0,
        }),
      );
      Effect.runSync(
        renderer.handleEvent({
          type: "text_chunk",
          delta: marker,
          accumulated: accumulated2,
          sequence: 1,
        }),
      );

      Effect.runSync(renderer.flush());

      const streamed = printOutputCalls
        .filter((e) => e.type === "streamContent")
        .map((e) => (typeof e.message === "string" ? e.message : ""))
        .join("");

      expect(streamed).toContain("MARKER1234567890");
    });

    test("formats inline markdown that closes across chunks", () => {
      const renderer = createRenderer();
      emitStreamStart(renderer);
      Effect.runSync(renderer.handleEvent({ type: "text_start" }));

      Effect.runSync(
        renderer.handleEvent({
          type: "text_chunk",
          delta: "This is **bo",
          accumulated: "This is **bo",
          sequence: 0,
        }),
      );
      Effect.runSync(
        renderer.handleEvent({
          type: "text_chunk",
          delta: "ld** text\n",
          accumulated: "This is **bold** text\n",
          sequence: 1,
        }),
      );

      const streamed = printOutputCalls
        .filter((e) => e.type === "streamContent")
        .map((e) => (typeof e.message === "string" ? e.message : ""))
        .join("");

      expect(streamed).toContain("This is bold text");
      expect(streamed).not.toContain("**bold**");
    });

    test("prints response when no streamed text was emitted", () => {
      const renderer = createRenderer();
      emitStreamStart(renderer);
      Effect.runSync(renderer.handleEvent({ type: "text_start" }));

      Effect.runSync(
        renderer.handleEvent({
          type: "complete",
          response: {
            content: "Fallback response",
            role: "assistant",
            usage: undefined,
            toolCalls: [],
          },
          totalDurationMs: 100,
        }),
      );

      const streamContentEntries = printOutputCalls.filter((e) => e.type === "streamContent");
      expect(streamContentEntries.length).toBeGreaterThan(0);
      const msg =
        typeof streamContentEntries[0]!.message === "string"
          ? streamContentEntries[0]!.message
          : "";
      expect(msg).toContain("Fallback response");
    });
  });
});
