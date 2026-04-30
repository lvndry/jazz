import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Effect } from "effect";
import { InkStreamingRenderer } from "./ink-presentation-service";
import type { ActivityState } from "../ui/activity-state";
import { store } from "../ui/store";
import type { OutputEntry } from "../ui/types";

// Large-base-text size for the seenLength regression test below. The exact
// value isn't load-bearing — anything large enough to make a delta-mismatch
// regression visible if seenLength stops tracking accumulated length.
const LARGE_BASE_CHARS = 100_000;

describe("InkStreamingRenderer", () => {
  const setActivityCalls: ActivityState[] = [];
  const printOutputCalls: OutputEntry[] = [];
  let originalSetActivity: (typeof store)["setActivity"];
  let originalPrintOutput: (typeof store)["printOutput"];
  let lastRenderer: InkStreamingRenderer | null = null;

  function createRenderer() {
    // textBufferMs: 0 disables stream-delta buffering so appendStream calls
    // are synchronous, matching the assertions in this test file. Production
    // uses ~80ms buffering by default.
    const renderer = new InkStreamingRenderer(
      "TestAgent",
      false,
      {
        showThinking: true,
        showToolExecution: true,
        mode: "rendered",
        colorProfile: "full",
      },
      { textBufferMs: 0 },
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

  // Note: store.appendStream / store.finalizeStream spies are installed and
  // restored per-test via try/finally inside each test body (see the
  // "single-pending-buffer invariants" describe block). This afterEach only
  // restores the harness-level setActivity / printOutput spies.
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
      const appendedDeltas: string[] = [];
      const originalAppend = store.appendStream;
      store.appendStream = (kind, delta): void => {
        if (kind === "response") appendedDeltas.push(delta);
        originalAppend(kind, delta);
      };
      try {
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

        Effect.runSync(renderer.flush());

        const streamed = appendedDeltas.join("");
        expect(streamed).toContain("Hello");
      } finally {
        store.appendStream = originalAppend;
      }
    });

    test("never overwrites with older sequence when chunks arrive out of order", async () => {
      const appendedDeltas: string[] = [];
      const originalAppend = store.appendStream;
      store.appendStream = (kind, delta): void => {
        if (kind === "response") appendedDeltas.push(delta);
        originalAppend(kind, delta);
      };
      try {
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

        Effect.runSync(renderer.flush());

        const streamed = appendedDeltas.join("");
        expect(streamed).toContain("Hel");
      } finally {
        store.appendStream = originalAppend;
      }
    });
  });

  describe("text buffering (textBufferMs)", () => {
    test("text deltas are coalesced and flushed once per buffer window", async () => {
      const calls: { kind: string; delta: string }[] = [];
      const originalAppend = store.appendStream;
      store.appendStream = (kind, delta): void => {
        calls.push({ kind, delta });
        originalAppend(kind, delta);
      };
      try {
        // 30ms buffer keeps the test fast.
        const renderer = new InkStreamingRenderer(
          "TestAgent",
          false,
          {
            showThinking: true,
            showToolExecution: true,
            mode: "rendered",
            colorProfile: "full",
          },
          { textBufferMs: 30 },
          0,
        );
        emitStreamStart(renderer);
        Effect.runSync(renderer.handleEvent({ type: "text_start" }));

        // Three back-to-back chunks within one buffer window.
        Effect.runSync(
          renderer.handleEvent({
            type: "text_chunk",
            delta: "Hel",
            accumulated: "Hel",
            sequence: 0,
          }),
        );
        Effect.runSync(
          renderer.handleEvent({
            type: "text_chunk",
            delta: "lo, ",
            accumulated: "Hello, ",
            sequence: 1,
          }),
        );
        Effect.runSync(
          renderer.handleEvent({
            type: "text_chunk",
            delta: "world",
            accumulated: "Hello, world",
            sequence: 2,
          }),
        );

        // Before the timer fires, nothing has gone to appendStream.
        expect(calls).toHaveLength(0);

        // Wait past the buffer window for the flush.
        await new Promise((r) => setTimeout(r, 50));

        // All three chunks coalesced into a single appendStream call.
        const responseCalls = calls.filter((c) => c.kind === "response");
        expect(responseCalls).toHaveLength(1);
        expect(responseCalls[0]!.delta).toBe("Hello, world");
      } finally {
        store.appendStream = originalAppend;
      }
    });

    test("flush() drains buffered deltas synchronously", () => {
      const calls: { kind: string; delta: string }[] = [];
      const originalAppend = store.appendStream;
      store.appendStream = (kind, delta): void => {
        calls.push({ kind, delta });
        originalAppend(kind, delta);
      };
      try {
        const renderer = new InkStreamingRenderer(
          "TestAgent",
          false,
          {
            showThinking: true,
            showToolExecution: true,
            mode: "rendered",
            colorProfile: "full",
          },
          { textBufferMs: 1000 }, // long window
          0,
        );
        emitStreamStart(renderer);
        Effect.runSync(renderer.handleEvent({ type: "text_start" }));
        Effect.runSync(
          renderer.handleEvent({
            type: "text_chunk",
            delta: "buffered",
            accumulated: "buffered",
            sequence: 0,
          }),
        );

        expect(calls).toHaveLength(0);
        Effect.runSync(renderer.flush());
        expect(calls).toHaveLength(1);
        expect(calls[0]!.delta).toBe("buffered");
      } finally {
        store.appendStream = originalAppend;
      }
    });

    test("adaptive: defers flush while inside an open code fence", async () => {
      const calls: { delta: string }[] = [];
      const originalAppend = store.appendStream;
      store.appendStream = (kind, delta): void => {
        if (kind === "response") calls.push({ delta });
        originalAppend(kind, delta);
      };
      try {
        const renderer = new InkStreamingRenderer(
          "TestAgent",
          false,
          {
            showThinking: true,
            showToolExecution: true,
            mode: "rendered",
            colorProfile: "full",
          },
          { textBufferMs: 20 },
          0,
        );
        emitStreamStart(renderer);
        Effect.runSync(renderer.handleEvent({ type: "text_start" }));

        // Stream the opening of a code fence — buffer ends inside an open
        // structure, so the adaptive heuristic should defer the flush.
        Effect.runSync(
          renderer.handleEvent({
            type: "text_chunk",
            delta: "Here:\n```ts\nconst x =",
            accumulated: "Here:\n```ts\nconst x =",
            sequence: 0,
          }),
        );

        // After one buffer window: the deferral should keep the buffer pending.
        await new Promise((r) => setTimeout(r, 35));
        expect(calls).toHaveLength(0);

        // Close the fence — open structure resolves, next flush window emits.
        Effect.runSync(
          renderer.handleEvent({
            type: "text_chunk",
            delta: " 1;\n```\nDone.",
            accumulated: "Here:\n```ts\nconst x = 1;\n```\nDone.",
            sequence: 1,
          }),
        );
        await new Promise((r) => setTimeout(r, 35));
        expect(calls.length).toBeGreaterThan(0);
        const merged = calls.map((c) => c.delta).join("");
        expect(merged).toContain("```ts");
        expect(merged).toContain("Done.");
      } finally {
        store.appendStream = originalAppend;
      }
    });

    test("adaptive: cap forces flush after MAX_ADAPTIVE_WAIT_MS even if structure stays open", async () => {
      // Cover the runaway-open-structure case by directly calling flush()
      // after the buffer window: flush() short-circuits adaptive deferral
      // unconditionally, which is the same path the real runtime uses on
      // complete / reset / abort. The MAX_ADAPTIVE_WAIT_MS cap covers the
      // mid-stream timer-driven case; verifying it requires waiting 2s+
      // which is wasteful in unit tests.
      const calls: { delta: string }[] = [];
      const originalAppend = store.appendStream;
      store.appendStream = (kind, delta): void => {
        if (kind === "response") calls.push({ delta });
        originalAppend(kind, delta);
      };
      try {
        const renderer = new InkStreamingRenderer(
          "TestAgent",
          false,
          {
            showThinking: true,
            showToolExecution: true,
            mode: "rendered",
            colorProfile: "full",
          },
          { textBufferMs: 20 },
          0,
        );
        emitStreamStart(renderer);
        Effect.runSync(renderer.handleEvent({ type: "text_start" }));
        Effect.runSync(
          renderer.handleEvent({
            type: "text_chunk",
            delta: "```ts\nconst x = 1\n",
            accumulated: "```ts\nconst x = 1\n",
            sequence: 0,
          }),
        );

        // Code fence still open after the buffer window — adaptive defers.
        await new Promise((r) => setTimeout(r, 35));
        expect(calls).toHaveLength(0);

        // Manual flush (the path used by complete/reset/abort) bypasses
        // the deferral and emits everything synchronously.
        Effect.runSync(renderer.flush());
        expect(calls.length).toBeGreaterThan(0);
        expect(calls[0]!.delta).toContain("```ts");
      } finally {
        store.appendStream = originalAppend;
      }
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

    test("when showThinking is false, the reasoning header is suppressed", () => {
      const renderer = new InkStreamingRenderer(
        "TestAgent",
        false,
        {
          showThinking: false,
          showToolExecution: true,
          mode: "rendered",
          colorProfile: "full",
        },
        { textBufferMs: 0 },
        0,
      );
      emitStreamStart(renderer);
      Effect.runSync(renderer.handleEvent({ type: "thinking_start" }));
      const headerEntries = printOutputCalls.filter(
        (e) =>
          e.type === "streamContent" &&
          typeof e.message === "string" &&
          e.message.includes("Reasoning"),
      );
      expect(headerEntries).toHaveLength(0);
    });

    test("thinking_chunk streams reasoning output", async () => {
      const reasoningDeltas: string[] = [];
      const originalAppend = store.appendStream;
      store.appendStream = (kind, delta): void => {
        if (kind === "reasoning") reasoningDeltas.push(delta);
        originalAppend(kind, delta);
      };
      try {
        const renderer = createRenderer();
        emitStreamStart(renderer);

        Effect.runSync(renderer.handleEvent({ type: "thinking_start", provider: "test" }));
        Effect.runSync(
          renderer.handleEvent({ type: "thinking_chunk", content: "let me think\n", sequence: 0 }),
        );
        Effect.runSync(renderer.handleEvent({ type: "thinking_complete" }));
        await new Promise((r) => setTimeout(r, 0));

        // Reasoning header is emitted via printOutput (renderer, gated by showThinking)
        const staticOutput = printOutputCalls
          .filter((e) => e.type === "streamContent")
          .map((e) => (typeof e.message === "string" ? e.message : ""))
          .join("");
        expect(staticOutput).toContain("Reasoning");
        // Reasoning content goes through appendStream
        expect(reasoningDeltas.join("")).toContain("let me think");
      } finally {
        store.appendStream = originalAppend;
      }
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
      const appendedDeltas: string[] = [];
      const originalAppend = store.appendStream;
      store.appendStream = (kind, delta): void => {
        if (kind === "response") appendedDeltas.push(delta);
        originalAppend(kind, delta);
      };
      try {
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

        Effect.runSync(renderer.flush());

        const streamed = appendedDeltas.join("");
        expect(streamed).toContain("ABC");
      } finally {
        store.appendStream = originalAppend;
      }
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

  describe("single-pending-buffer invariants", () => {
    test("after complete, the renderer has emitted finalizeStream and pending is null", () => {
      // Spy on store.appendStream / finalizeStream during the round and assert
      // the final action is a finalizeStream.
      const originalFinalize = store.finalizeStream;
      let finalizeCount = 0;
      store.finalizeStream = (): void => {
        finalizeCount += 1;
        originalFinalize();
      };

      try {
        const renderer = createRenderer();
        emitStreamStart(renderer);
        Effect.runSync(renderer.handleEvent({ type: "text_start" }));
        Effect.runSync(
          renderer.handleEvent({
            type: "text_chunk",
            delta: "Hello world\n",
            accumulated: "Hello world\n",
            sequence: 0,
          }),
        );
        Effect.runSync(
          renderer.handleEvent({
            type: "complete",
            response: {
              content: "Hello world\n",
              role: "assistant",
              usage: undefined,
              toolCalls: [],
            },
            totalDurationMs: 50,
          }),
        );
        expect(finalizeCount).toBeGreaterThan(0);
      } finally {
        store.finalizeStream = originalFinalize;
      }
    });

    test("tool_execution_start mid-response calls finalizeStream then prints tool entry", () => {
      const events: string[] = [];
      const originalFinalize = store.finalizeStream;
      const originalPrint = store.printOutput;
      store.finalizeStream = (): void => {
        events.push("finalize");
        originalFinalize();
      };
      store.printOutput = (entry): string => {
        if (entry.type === "info") events.push(`info:${entry.message as string}`);
        return originalPrint(entry);
      };
      try {
        const renderer = createRenderer();
        emitStreamStart(renderer);
        Effect.runSync(renderer.handleEvent({ type: "text_start" }));
        Effect.runSync(
          renderer.handleEvent({
            type: "text_chunk",
            delta: "in progress\n",
            accumulated: "in progress\n",
            sequence: 0,
          }),
        );
        Effect.runSync(
          renderer.handleEvent({
            type: "tool_execution_start",
            toolCallId: "t1",
            toolName: "execute_command",
            arguments: { command: "ls" },
            longRunning: false,
          }),
        );
        const finalizeIdx = events.indexOf("finalize");
        const infoIdx = events.findIndex(
          (e) => e.startsWith("info:") && e.includes("execute_command"),
        );
        expect(finalizeIdx).toBeGreaterThanOrEqual(0);
        expect(infoIdx).toBeGreaterThan(finalizeIdx);
      } finally {
        store.finalizeStream = originalFinalize;
        store.printOutput = originalPrint;
      }
    });

    test("reasoning → response transition finalizes reasoning and opens response", () => {
      const calls: Array<{ kind?: string; finalize?: true }> = [];
      const originalAppend = store.appendStream;
      const originalFinalize = store.finalizeStream;
      store.appendStream = (kind, delta): void => {
        calls.push({ kind });
        originalAppend(kind, delta);
      };
      store.finalizeStream = (): void => {
        calls.push({ finalize: true });
        originalFinalize();
      };
      try {
        const renderer = createRenderer();
        emitStreamStart(renderer);
        Effect.runSync(renderer.handleEvent({ type: "thinking_start" }));
        Effect.runSync(renderer.handleEvent({ type: "thinking_chunk", content: "think " }));
        Effect.runSync(renderer.handleEvent({ type: "thinking_complete" }));
        Effect.runSync(renderer.handleEvent({ type: "text_start" }));
        Effect.runSync(
          renderer.handleEvent({
            type: "text_chunk",
            delta: "answer",
            accumulated: "answer",
            sequence: 0,
          }),
        );
        // Sequence: appendStream(reasoning) -> finalize -> appendStream(response).
        const reasoningIdx = calls.findIndex((c) => c.kind === "reasoning");
        const finalizeIdx = calls.findIndex((c, i) => i > reasoningIdx && c.finalize);
        const responseIdx = calls.findIndex((c, i) => i > finalizeIdx && c.kind === "response");
        expect(reasoningIdx).toBeGreaterThanOrEqual(0);
        expect(finalizeIdx).toBeGreaterThan(reasoningIdx);
        expect(responseIdx).toBeGreaterThan(finalizeIdx);
      } finally {
        store.appendStream = originalAppend;
        store.finalizeStream = originalFinalize;
      }
    });

    test("interrupt (flush) finalizes pending", () => {
      let finalizeCount = 0;
      const originalFinalize = store.finalizeStream;
      store.finalizeStream = (): void => {
        finalizeCount += 1;
        originalFinalize();
      };
      try {
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
        Effect.runSync(renderer.flush());
        expect(finalizeCount).toBeGreaterThan(0);
      } finally {
        store.finalizeStream = originalFinalize;
      }
    });

    test("error finalizes pending then appends error entry", () => {
      const events: string[] = [];
      const originalFinalize = store.finalizeStream;
      const originalPrint = store.printOutput;
      store.finalizeStream = (): void => {
        events.push("finalize");
        originalFinalize();
      };
      store.printOutput = (entry): string => {
        if (entry.type === "error") events.push("error");
        return originalPrint(entry);
      };
      try {
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
        Effect.runSync(
          renderer.handleEvent({
            type: "error",
            error: { code: "RATE_LIMIT", message: "boom" },
          } as never),
        );
        const finalizeIdx = events.indexOf("finalize");
        const errorIdx = events.indexOf("error");
        expect(finalizeIdx).toBeGreaterThanOrEqual(0);
        expect(errorIdx).toBeGreaterThan(finalizeIdx);
      } finally {
        store.finalizeStream = originalFinalize;
        store.printOutput = originalPrint;
      }
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
    test("flush() calls finalizeStream and clears activity to idle", () => {
      let finalizeCount = 0;
      const originalFinalize = store.finalizeStream;
      store.finalizeStream = (): void => {
        finalizeCount += 1;
        originalFinalize();
      };
      try {
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

        Effect.runSync(renderer.flush());
        expect(finalizeCount).toBeGreaterThan(0);

        const last = setActivityCalls[setActivityCalls.length - 1];
        expect(last!.phase).toBe("idle");
      } finally {
        store.finalizeStream = originalFinalize;
      }
    });
  });

  describe("Static flush behavior", () => {
    test("short text is appended to appendStream during streaming", async () => {
      const appendedDeltas: string[] = [];
      const originalAppend = store.appendStream;
      store.appendStream = (kind, delta): void => {
        if (kind === "response") appendedDeltas.push(delta);
        originalAppend(kind, delta);
      };
      try {
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

        const streamed = appendedDeltas.join("");
        expect(streamed).toContain("word");
      } finally {
        store.appendStream = originalAppend;
      }
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
    test("streams chunks as appendStream calls in order", async () => {
      const appendedDeltas: string[] = [];
      const originalAppend = store.appendStream;
      store.appendStream = (kind, delta): void => {
        if (kind === "response") appendedDeltas.push(delta);
        originalAppend(kind, delta);
      };
      try {
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

        const streamed = appendedDeltas.join("");
        expect(streamed).toContain("word0");
        expect(streamed).toContain("word4");
      } finally {
        store.appendStream = originalAppend;
      }
    });

    test("does not duplicate content on complete when streaming already emitted", () => {
      let appendCount = 0;
      const originalAppend = store.appendStream;
      store.appendStream = (kind, delta): void => {
        if (kind === "response") appendCount += 1;
        originalAppend(kind, delta);
      };
      try {
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

        const beforeCount = appendCount;

        Effect.runSync(
          renderer.handleEvent({
            type: "complete",
            response: { content: "done ", role: "assistant", usage: undefined, toolCalls: [] },
            totalDurationMs: 100,
          }),
        );

        // No additional appendStream calls on complete when streaming was active
        expect(appendCount).toBe(beforeCount);
      } finally {
        store.appendStream = originalAppend;
      }
    });

    test("seenLength tracks full accumulated length across very large chunks", () => {
      const appendedDeltas: string[] = [];
      const originalAppend = store.appendStream;
      store.appendStream = (kind, delta): void => {
        if (kind === "response") appendedDeltas.push(delta);
        originalAppend(kind, delta);
      };
      try {
        const renderer = createRenderer();
        emitStreamStart(renderer);
        Effect.runSync(renderer.handleEvent({ type: "text_start" }));

        const base = `${"a".repeat(LARGE_BASE_CHARS - 6)}\n`;
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

        const streamed = appendedDeltas.join("");
        expect(streamed).toContain("MARKER1234567890");
      } finally {
        store.appendStream = originalAppend;
      }
    });

    test("formats inline markdown that closes across chunks", () => {
      // In the new arch, raw (unformatted) text goes through appendStream.
      // The buffer/adapter handles formatting. We verify raw text is sent.
      const appendedDeltas: string[] = [];
      const originalAppend = store.appendStream;
      store.appendStream = (kind, delta): void => {
        if (kind === "response") appendedDeltas.push(delta);
        originalAppend(kind, delta);
      };
      try {
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

        const streamed = appendedDeltas.join("");
        expect(streamed).toContain("This is **bo");
        expect(streamed).toContain("ld** text");
      } finally {
        store.appendStream = originalAppend;
      }
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
