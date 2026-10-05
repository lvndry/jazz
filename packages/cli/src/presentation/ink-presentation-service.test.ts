import { DEFAULT_DISPLAY_CONFIG } from "@jazz/core/agent/types";
import type { ChatCompletionResponse } from "@jazz/core/types/chat";
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import chalk from "chalk";
import { Effect, Fiber } from "effect";
import { renderToString } from "ink";
import React from "react";
import { InkPresentationService, InkStreamingRenderer } from "./ink-presentation-service";
import { formatTurnReceipt } from "./turn-receipt";
import type { ActivityState } from "../ui/activity-state";
import { ApprovalView } from "../ui/ApprovalView";
import { contentFromOutput } from "../ui/document";
import { interruptSummaryLines } from "../ui/models/interrupt";
import { OutputEntryView } from "../ui/OutputEntryView";
import { store } from "../ui/store";
import type { OutputEntry, PromptState } from "../ui/types";

function completeResponse(content: string): ChatCompletionResponse {
  return { id: "test", model: "test", content, toolCalls: [] };
}

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
        showReasoning: true,
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
    store.setCollapseReasoning(true);
  });

  test("an answer the model pauses to think in the middle of stays one block", () => {
    store.clearOutputs();
    const renderer = createRenderer();
    emitStreamStart(renderer);
    Effect.runSync(renderer.handleEvent({ type: "text_start" }));
    Effect.runSync(
      renderer.handleEvent({
        type: "text_chunk",
        delta: "Started it. I",
        accumulated: "Started it. I",
        sequence: 0,
      }),
    );
    Effect.runSync(renderer.handleEvent({ type: "thinking_start", provider: "test" }));
    Effect.runSync(
      renderer.handleEvent({ type: "thinking_chunk", content: "Already replied.", sequence: 0 }),
    );
    Effect.runSync(renderer.handleEvent({ type: "thinking_complete" }));
    Effect.runSync(
      renderer.handleEvent({
        type: "text_chunk",
        delta: "'ll report back.",
        accumulated: "Started it. I'll report back.",
        sequence: 1,
      }),
    );
    Effect.runSync(renderer.flush());

    const entries = store.getDocumentSnapshot().entries.map((entry) => entry.content);
    expect(entries.map((content) => content.kind)).toEqual(["header", "reasoning", "agent"]);
    expect(entries[2]).toMatchObject({ markdown: "Started it. I'll report back." });
  });

  test("child lifecycle events do not settle or relabel the concurrent main stream", () => {
    store.clearOutputs();
    const regionId = store.openEphemeral("subagent", "Child", 8, {
      task: "inspect a file",
      acceptsMessages: true,
    });
    const child = new InkStreamingRenderer(
      "Child",
      true,
      DEFAULT_DISPLAY_CONFIG,
      { textBufferMs: 0 },
      0,
      { kind: "ephemeral", regionId },
    );
    store.appendStream("response", "main prefix");
    store.setActivity({ phase: "streaming", agentName: "Main", text: "main prefix" });
    store.resetRunStats({
      provider: "main-provider",
      model: "main-model",
      tokensInContext: 100,
      maxContextTokens: 8_000,
    });
    store.setExpandableDiff("main output");
    const detail = store.getExpandableDiff();
    const expected = store.getDocumentSnapshot();
    const activity = store.getSessionSnapshot().activity;
    const assertMainUnchanged = (): void => {
      expect(store.getDocumentSnapshot()).toBe(expected);
      expect(store.getSessionSnapshot().activity).toBe(activity);
      expect(store.getExpandableDiff()).toBe(detail);
      expect(store.getRunStatsSnapshot()).toMatchObject({
        provider: "main-provider",
        model: "main-model",
        tokensInContext: 100,
        maxContextTokens: 8_000,
      });
    };
    try {
      Effect.runSync(
        child.handleEvent({
          type: "stream_start",
          provider: "child-provider",
          model: "child-model",
          pinnedContextWindow: 900,
          timestamp: 0,
        }),
      );
      assertMainUnchanged();
      Effect.runSync(child.handleEvent({ type: "text_start" }));
      Effect.runSync(
        child.handleEvent({
          type: "text_chunk",
          delta: "child answer",
          accumulated: "child answer",
          sequence: 0,
        }),
      );
      Effect.runSync(
        child.handleEvent({
          type: "tool_execution_start",
          toolName: "read_file",
          toolCallId: "child-tool",
          arguments: { path: "child.txt" },
        }),
      );
      Effect.runSync(
        child.handleEvent({
          type: "tool_execution_complete",
          toolCallId: "child-tool",
          result: "child result",
          summary: "child inspected",
          durationMs: 5,
          success: true,
        }),
      );
      assertMainUnchanged();
      Effect.runSync(child.flush());
      assertMainUnchanged();
      Effect.runSync(child.reset());
      assertMainUnchanged();
      emitStreamStart(child);
      Effect.runSync(
        child.handleEvent({
          type: "complete",
          response: {
            ...completeResponse("child fallback answer"),
            usage: {
              promptTokens: 700,
              completionTokens: 30,
              totalTokens: 730,
              billedCostUSD: 0.01,
            },
          },
          totalDurationMs: 100,
          metrics: { firstTokenLatencyMs: 10 },
        }),
      );
      assertMainUnchanged();
      expect(store.getRunStatsSnapshot()).toMatchObject({
        promptTokens: 700,
        completionTokens: 30,
        costUSD: 0.01,
      });
      const run = store.getSubagentsSnapshot().runs.find((candidate) => candidate.id === regionId);
      expect(run?.entries).toContainEqual(
        expect.objectContaining({
          kind: "response",
          text: "child answer",
        }),
      );
      expect(run?.entries).toContainEqual(
        expect.objectContaining({
          kind: "response",
          text: "child fallback answer",
        }),
      );
      expect(run?.entries).toContainEqual(
        expect.objectContaining({
          kind: "tool",
          summary: "child inspected",
          status: "ok",
        }),
      );
      store.appendStream("response", " main suffix");
      expect(store.getDocumentSnapshot().entries).toHaveLength(1);
      expect(store.getDocumentSnapshot().entries[0]?.id).toBe(expected.streamingId);
      expect(store.getDocumentSnapshot().entries[0]?.content).toEqual({
        kind: "agent",
        markdown: "main prefix main suffix",
      });
    } finally {
      Effect.runSync(child.reset());
      store.clearOutputs();
    }
  });

  test("a child renderer cannot change the main reasoning collapse preference", () => {
    store.clearOutputs();
    store.setCollapseReasoning(false);
    const childId = store.openEphemeral("subagent", "Child", 8);
    const child = new InkStreamingRenderer(
      "Child",
      false,
      DEFAULT_DISPLAY_CONFIG,
      { textBufferMs: 0 },
      0,
      { kind: "ephemeral", regionId: childId },
    );
    try {
      const reasoningId = store.openEphemeral("reasoning", "Main reasoning", 8);
      store.appendEphemeral(reasoningId, "main reasoning remains expanded");
      store.collapseEphemeral(reasoningId, { durationMs: 10 });
      expect(store.isReasoningExpanded(reasoningId)).toBe(true);
    } finally {
      Effect.runSync(child.reset());
      store.clearOutputs();
    }
  });

  describe("document lease retirement", () => {
    test("late provider, tool, and complete events cannot modify a replacement document", async () => {
      store.clearOutputs();
      const renderer = createRenderer();
      emitStreamStart(renderer);
      Effect.runSync(renderer.handleEvent({ type: "text_start" }));
      Effect.runSync(
        renderer.handleEvent({
          type: "text_chunk",
          delta: "old answer",
          accumulated: "old answer",
          sequence: 0,
        }),
      );
      store.replaceDocument("new", [
        {
          id: "new-user",
          timestamp: "2026-01-01T00:00:00.000Z",
          content: { kind: "user", text: "new question" },
        },
      ]);
      store.setActivity({ phase: "thinking", agentName: "new agent" });
      const expected = store.getDocumentSnapshot();
      Effect.runSync(
        renderer.handleEvent({
          type: "text_chunk",
          delta: " late text",
          accumulated: "old answer late text",
          sequence: 1,
        }),
      );
      Effect.runSync(
        renderer.handleEvent({
          type: "tool_execution_start",
          toolName: "read_file",
          toolCallId: "old-tool",
          arguments: { path: "old.txt" },
        }),
      );
      Effect.runSync(
        renderer.handleEvent({
          type: "tool_execution_complete",
          toolCallId: "old-tool",
          result: "old result",
          durationMs: 1,
        }),
      );
      Effect.runSync(
        renderer.handleEvent({
          type: "complete",
          response: completeResponse("old final"),
          totalDurationMs: 50,
        }),
      );
      Effect.runSync(renderer.flush());
      Effect.runSync(renderer.reset());
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(store.getDocumentSnapshot()).toBe(expected);
      expect(store.getSessionSnapshot().activity).toEqual({
        phase: "thinking",
        agentName: "new agent",
      });
    });

    test("a buffered provider timer cannot publish after clear", async () => {
      store.clearOutputs();
      const renderer = new InkStreamingRenderer(
        "old",
        false,
        DEFAULT_DISPLAY_CONFIG,
        { textBufferMs: 20 },
        0,
      );
      emitStreamStart(renderer);
      Effect.runSync(renderer.handleEvent({ type: "text_start" }));
      Effect.runSync(
        renderer.handleEvent({
          type: "text_chunk",
          delta: "queued old answer",
          accumulated: "queued old answer",
          sequence: 0,
        }),
      );
      store.clearOutputs();
      const expected = store.getDocumentSnapshot();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(store.getDocumentSnapshot()).toBe(expected);
      expect(store.getDocumentSnapshot().entries).toHaveLength(0);
      Effect.runSync(renderer.reset());
    });
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
            showReasoning: true,
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
            showReasoning: true,
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
            showReasoning: true,
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
            showReasoning: true,
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

    test("when showReasoning is false, the reasoning header is suppressed", () => {
      const renderer = new InkStreamingRenderer(
        "TestAgent",
        false,
        {
          showReasoning: false,
          showToolExecution: true,
          mode: "rendered",
          colorProfile: "full",
        },
        { textBufferMs: 0 },
        0,
      );
      emitStreamStart(renderer);
      Effect.runSync(renderer.handleEvent({ type: "thinking_start", provider: "test" }));
      const headerEntries = printOutputCalls.filter(
        (e) =>
          e.type === "streamContent" &&
          typeof e.message === "string" &&
          e.message.includes("Reasoning"),
      );
      expect(headerEntries).toHaveLength(0);
    });

    test("thinking events open a reasoning region, append to it, and collapse on complete", async () => {
      const ephemeralAppends: string[] = [];
      const originalOpen = store.openEphemeral;
      const originalAppend = store.appendEphemeral;
      const originalCollapse = store.collapseEphemeral;
      let openedKind: string | null = null;
      let collapsedFullText: string | undefined;

      store.openEphemeral = (kind, label, maxLines) => {
        openedKind = kind;
        return originalOpen(kind, label, maxLines);
      };
      store.appendEphemeral = (id, text) => {
        ephemeralAppends.push(text);
        originalAppend(id, text);
      };
      store.collapseEphemeral = (id, summary) => {
        collapsedFullText = summary.fullText;
        originalCollapse(id, summary);
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

        expect(openedKind ?? "").toBe("reasoning");
        expect(ephemeralAppends.join("")).toContain("let me think");
        expect(collapsedFullText).toContain("let me think");
      } finally {
        store.openEphemeral = originalOpen;
        store.appendEphemeral = originalAppend;
        store.collapseEphemeral = originalCollapse;
      }
    });

    test("reasoning that returned no text does not offer Ctrl+R", () => {
      const originalCollapse = store.collapseEphemeral;
      const lines: string[] = [];
      store.collapseEphemeral = (id, summary) => {
        if (summary.line !== undefined) lines.push(summary.line);
        originalCollapse(id, summary);
      };
      try {
        const renderer = createRenderer();
        emitStreamStart(renderer);
        Effect.runSync(renderer.handleEvent({ type: "thinking_start", provider: "test" }));
        Effect.runSync(renderer.handleEvent({ type: "thinking_complete" }));
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain("Reasoning");
        expect(lines[0]).not.toContain("ctrl+r");
      } finally {
        store.collapseEphemeral = originalCollapse;
      }
    });

    test("when collapseReasoning is false, thinking settles as full text without Ctrl+R", async () => {
      const renderer = new InkStreamingRenderer(
        "TestAgent",
        false,
        {
          showReasoning: true,
          showToolExecution: true,
          mode: "rendered",
          colorProfile: "full",
          collapseReasoning: false,
        },
        { textBufferMs: 0 },
        0,
      );
      lastRenderer = renderer;
      emitStreamStart(renderer);
      Effect.runSync(renderer.handleEvent({ type: "thinking_start", provider: "test" }));
      Effect.runSync(
        renderer.handleEvent({ type: "thinking_chunk", content: "let me think", sequence: 0 }),
      );
      Effect.runSync(renderer.handleEvent({ type: "thinking_complete" }));
      await new Promise((r) => setTimeout(r, 0));

      const reasoning = store
        .getOutputSnapshot()
        .entries.filter((e) => contentFromOutput(e).kind === "reasoning");
      expect(reasoning.length).toBeGreaterThan(0);
      expect(store.isReasoningExpanded(reasoning[0]!.id)).toBe(true);
      expect(reasoning[0]!.message).toMatchObject({ kind: "reasoning", text: "let me think" });
      expect(String(reasoning[0]!.message)).not.toContain("ctrl+r");
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

    test("flush after a running tool returns activity to idle", async () => {
      const renderer = createRenderer();
      emitStreamStart(renderer);
      Effect.runSync(
        renderer.handleEvent({
          type: "tool_execution_start",
          toolName: "execute_command",
          toolCallId: "tc-1",
        }),
      );
      Effect.runSync(renderer.flush());
      await new Promise((r) => setTimeout(r, 0));

      const last = setActivityCalls[setActivityCalls.length - 1];
      expect(last!.phase).toBe("idle");
    });

    test("error after a running tool leaves activity in error, not tool-execution", async () => {
      const renderer = createRenderer();
      emitStreamStart(renderer);
      Effect.runSync(
        renderer.handleEvent({
          type: "tool_execution_start",
          toolName: "execute_command",
          toolCallId: "tc-1",
        }),
      );
      Effect.runSync(
        renderer.handleEvent({
          type: "error",
          error: { code: "INTERRUPTED", message: "GenerationInterruptedError" },
          recoverable: false,
        } as never),
      );
      await new Promise((r) => setTimeout(r, 0));

      const last = setActivityCalls[setActivityCalls.length - 1];
      expect(last!.phase).toBe("error");
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

    test("complete clears tools that have no matching completion event", async () => {
      const renderer = createRenderer();
      emitStreamStart(renderer);

      Effect.runSync(
        renderer.handleEvent({
          type: "tool_execution_start",
          toolName: "retrieve_tool_result",
          toolCallId: "tc-stale",
        }),
      );
      Effect.runSync(
        renderer.handleEvent({
          type: "complete",
          response: completeResponse("done"),
          totalDurationMs: 100,
        }),
      );

      // A new turn must not inherit the previous turn's tool row.
      emitStreamStart(renderer);
      Effect.runSync(
        renderer.handleEvent({
          type: "tool_execution_start",
          toolName: "http",
          toolCallId: "tc-new",
        }),
      );
      const latest = setActivityCalls.at(-1);
      expect(latest?.phase).toBe("tool-execution");
      if (latest?.phase === "tool-execution") {
        expect(latest.tools.map((tool) => tool.toolCallId)).toEqual(["tc-new"]);
      }
    });
  });

  describe("sub-agent tool routing", () => {
    test("routes sub-agent tool activity into its ephemeral panel, not scrollback", async () => {
      const ephemeralAppends: Array<{ id: string; text: string }> = [];
      const originalAppend = store.appendEphemeral;
      store.appendEphemeral = (id, text) => {
        ephemeralAppends.push({ id, text });
        return originalAppend(id, text);
      };

      const renderer = new InkStreamingRenderer(
        "SubAgent",
        false,
        { showReasoning: true, showToolExecution: true, mode: "rendered", colorProfile: "full" },
        { textBufferMs: 0 },
        0,
        { kind: "ephemeral", regionId: "eph-sub-1" },
      );

      try {
        emitStreamStart(renderer);
        // stream_start writes an agent header to scrollback; baseline past it
        // so the assertion below isolates tool cards.
        const scrollbackBaseline = printOutputCalls.length;

        Effect.runSync(
          renderer.handleEvent({
            type: "tool_execution_start",
            toolName: "read_file",
            toolCallId: "tc-1",
            arguments: { path: "a.ts" },
          }),
        );
        Effect.runSync(
          renderer.handleEvent({
            type: "tool_execution_complete",
            toolCallId: "tc-1",
            result: "ok",
            durationMs: 42,
            summary: "read a.ts",
          }),
        );
        await new Promise((r) => setTimeout(r, 0));

        const combined = ephemeralAppends
          .filter((entry) => entry.id === "eph-sub-1")
          .map((entry) => entry.text)
          .join("");
        expect(combined).toContain("read_file");
        expect(combined).toContain("read a.ts");
        expect(combined).toContain("42ms");

        expect(printOutputCalls.length).toBe(scrollbackBaseline);
      } finally {
        store.appendEphemeral = originalAppend;
        Effect.runSync(renderer.reset());
      }
    });

    test("records a sub-agent's tool calls on its run as plain data", async () => {
      const originalLevel = chalk.level;
      chalk.level = 3;
      const regionId = store.openEphemeral("subagent", "Solver", 12, {
        task: "Read the file",
        acceptsMessages: true,
      });
      const renderer = new InkStreamingRenderer(
        "Solver",
        false,
        { showReasoning: true, showToolExecution: true, mode: "rendered", colorProfile: "full" },
        { textBufferMs: 0 },
        0,
        { kind: "ephemeral", regionId },
      );

      try {
        emitStreamStart(renderer);
        Effect.runSync(
          renderer.handleEvent({
            type: "tool_execution_start",
            toolName: "search_tools",
            toolCallId: "tc-plain",
            arguments: { query: "execute_command" },
          }),
        );
        Effect.runSync(
          renderer.handleEvent({
            type: "tool_execution_complete",
            toolCallId: "tc-plain",
            result: "ok",
            durationMs: 7,
            summary: chalk.cyan("found 1 tool"),
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));

        const run = store
          .getSubagentsSnapshot()
          .runs.find((candidate) => candidate.id === regionId);
        const tool = run?.entries.find((entry) => entry.kind === "tool");
        expect(tool).toMatchObject({ kind: "tool", status: "ok", summary: "found 1 tool" });
        const serialized = JSON.stringify(tool);
        expect(serialized).toContain("execute_command");
        expect(serialized).not.toContain("\\u001b");
      } finally {
        chalk.level = originalLevel;
        Effect.runSync(renderer.reset());
        store.collapseEphemeral(regionId, { durationMs: 0 });
      }
    });

    test("routes the metrics outro into the sub-agent's ephemeral panel, not scrollback", async () => {
      const ephemeralAppends: Array<{ id: string; text: string }> = [];
      const originalAppend = store.appendEphemeral;
      store.appendEphemeral = (id, text) => {
        ephemeralAppends.push({ id, text });
        return originalAppend(id, text);
      };

      const renderer = new InkStreamingRenderer(
        "SubAgent",
        true,
        { showReasoning: true, showToolExecution: true, mode: "rendered", colorProfile: "full" },
        { textBufferMs: 0 },
        0,
        { kind: "ephemeral", regionId: "eph-sub-2" },
      );

      try {
        emitStreamStart(renderer);
        const scrollbackBaseline = printOutputCalls.length;

        Effect.runSync(
          renderer.handleEvent({
            type: "complete",
            response: completeResponse("done"),
            totalDurationMs: 100,
            metrics: { firstTokenLatencyMs: 10, totalTokens: 42 },
          }),
        );
        await new Promise((r) => setTimeout(r, 0));

        const combined = ephemeralAppends
          .filter((entry) => entry.id === "eph-sub-2")
          .map((entry) => entry.text)
          .join("");
        expect(combined).toContain("42 tok");
        expect(combined).not.toContain("tok/s");

        const debugScrollbackEntries = printOutputCalls
          .slice(scrollbackBaseline)
          .filter((e) => e.type === "debug");
        expect(debugScrollbackEntries).toHaveLength(0);
      } finally {
        store.appendEphemeral = originalAppend;
        Effect.runSync(renderer.reset());
      }
    });
  });

  describe("metrics outro", () => {
    test("closes a multi-step turn with one receipt, not one per model request", () => {
      const renderer = new InkStreamingRenderer(
        "TestAgent",
        true,
        { showReasoning: true, showToolExecution: true, mode: "rendered", colorProfile: "full" },
        { textBufferMs: 0 },
      );
      try {
        emitStreamStart(renderer);
        const baseline = printOutputCalls.length;
        const toolStep: ChatCompletionResponse = {
          ...completeResponse(""),
          toolCalls: [
            { id: "call-1", type: "function", function: { name: "ls", arguments: "{}" } },
          ],
          usage: { promptTokens: 13_000, completionTokens: 46, totalTokens: 13_046 },
        };
        const finalStep: ChatCompletionResponse = {
          ...completeResponse("done"),
          usage: { promptTokens: 17_000, completionTokens: 56, totalTokens: 17_056 },
        };
        for (const [response, durationMs] of [
          [toolStep, 5_900],
          [finalStep, 3_800],
        ] as const) {
          Effect.runSync(
            renderer.handleEvent({
              type: "complete",
              response,
              totalDurationMs: durationMs,
              metrics: { firstTokenLatencyMs: 10 },
            }),
          );
        }
        const receipts = printOutputCalls
          .slice(baseline)
          .filter((entry) => contentFromOutput(entry).kind === "turn-receipt");
        expect(receipts).toHaveLength(1);
        const receipt = contentFromOutput(receipts[0]!);
        expect(receipt.kind === "turn-receipt" ? formatTurnReceipt(receipt) : undefined).toBe(
          "9.7s · 2 steps · 30k in → 102 out · 10.5 tok/s",
        );
      } finally {
        Effect.runSync(renderer.reset());
      }
    });

    test("keeps decode speed out of the turn receipt", async () => {
      const ephemeralAppends: Array<{ id: string; text: string }> = [];
      const originalAppend = store.appendEphemeral;
      store.appendEphemeral = (id, text) => {
        ephemeralAppends.push({ id, text });
        return originalAppend(id, text);
      };

      const renderer = new InkStreamingRenderer(
        "SubAgent",
        true,
        { showReasoning: true, showToolExecution: true, mode: "rendered", colorProfile: "full" },
        { textBufferMs: 0 },
        0,
        { kind: "ephemeral", regionId: "eph-tps" },
      );

      try {
        emitStreamStart(renderer);
        Effect.runSync(
          renderer.handleEvent({
            type: "complete",
            response: completeResponse("done"),
            totalDurationMs: 100,
            metrics: { firstTokenLatencyMs: 10, totalTokens: 42, tokensPerSecond: 41.26 },
          }),
        );
        await new Promise((r) => setTimeout(r, 0));

        const combined = ephemeralAppends
          .filter((entry) => entry.id === "eph-tps")
          .map((entry) => entry.text)
          .join("");
        expect(combined).toContain("42 tok");
        expect(combined).not.toContain("tok/s");
      } finally {
        store.appendEphemeral = originalAppend;
        Effect.runSync(renderer.reset());
      }
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
          response: completeResponse("Hello world"),
          totalDurationMs: 100,
        }),
      );

      store.setActivity = origActivity;
      store.printOutput = origPrint;

      // Complete should still transition activity to idle
      const idleIdx = callOrder.indexOf("activity:idle");
      expect(idleIdx).toBeGreaterThanOrEqual(0);
    });

    test("does not emit a second semantic answer when streaming was active", () => {
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
          response: completeResponse("response"),
          totalDurationMs: 50,
        }),
      );

      expect(
        printOutputCalls.filter((entry) => contentFromOutput(entry).kind === "agent"),
      ).toHaveLength(0);
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
    test("emits semantic answer content when no stream_start was emitted", () => {
      const renderer = createRenderer();
      printOutputCalls.length = 0;
      Effect.runSync(
        renderer.handleEvent({
          type: "complete",
          response: completeResponse("Non-streamed answer"),
          totalDurationMs: 50,
        }),
      );
      expect(printOutputCalls.some((entry) => contentFromOutput(entry).kind === "agent")).toBe(
        true,
      );
      const response = printOutputCalls
        .map(contentFromOutput)
        .find((content) => content.kind === "agent");
      expect(response).toEqual({ kind: "agent", markdown: "Non-streamed answer" });
    });

    test("does not print when response content is empty", () => {
      const renderer = createRenderer();

      printOutputCalls.length = 0;

      Effect.runSync(
        renderer.handleEvent({
          type: "complete",
          response: completeResponse(""),
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
            response: completeResponse("Hello world\n"),
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
        if (entry.type === "info") {
          const content = contentFromOutput(entry);
          events.push(`info:${content.kind === "notice" ? content.text : ""}`);
        }
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

    test("reasoning → response transition collapses the reasoning region and routes response to scrollback", () => {
      const calls: Array<{
        op: "openEphemeral" | "appendEphemeral" | "collapseEphemeral" | "appendStream";
        kind?: string;
      }> = [];
      const originalOpen = store.openEphemeral;
      const originalAppendEph = store.appendEphemeral;
      const originalCollapse = store.collapseEphemeral;
      const originalAppendStream = store.appendStream;

      store.openEphemeral = (kind, label, maxLines) => {
        calls.push({ op: "openEphemeral", kind });
        return originalOpen(kind, label, maxLines);
      };
      store.appendEphemeral = (id, text) => {
        calls.push({ op: "appendEphemeral" });
        originalAppendEph(id, text);
      };
      store.collapseEphemeral = (id, summary) => {
        calls.push({ op: "collapseEphemeral" });
        originalCollapse(id, summary);
      };
      store.appendStream = (kind, delta): void => {
        calls.push({ op: "appendStream", kind });
        originalAppendStream(kind, delta);
      };

      try {
        const renderer = createRenderer();
        emitStreamStart(renderer);
        Effect.runSync(renderer.handleEvent({ type: "thinking_start", provider: "test" }));
        Effect.runSync(
          renderer.handleEvent({ type: "thinking_chunk", content: "think ", sequence: 0 }),
        );
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

        const openIdx = calls.findIndex((c) => c.op === "openEphemeral" && c.kind === "reasoning");
        const appendEphIdx = calls.findIndex((c, i) => i > openIdx && c.op === "appendEphemeral");
        const collapseIdx = calls.findIndex(
          (c, i) => i > appendEphIdx && c.op === "collapseEphemeral",
        );
        const responseIdx = calls.findIndex(
          (c, i) => i > collapseIdx && c.op === "appendStream" && c.kind === "response",
        );

        expect(openIdx).toBeGreaterThanOrEqual(0);
        expect(appendEphIdx).toBeGreaterThan(openIdx);
        expect(collapseIdx).toBeGreaterThan(appendEphIdx);
        expect(responseIdx).toBeGreaterThan(collapseIdx);
      } finally {
        store.openEphemeral = originalOpen;
        store.appendEphemeral = originalAppendEph;
        store.collapseEphemeral = originalCollapse;
        store.appendStream = originalAppendStream;
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
          response: completeResponse(longLine),
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
            response: completeResponse("done "),
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
          response: completeResponse("Fallback response"),
          totalDurationMs: 100,
        }),
      );

      const streamContentEntries = printOutputCalls.filter((e) => e.type === "streamContent");
      expect(streamContentEntries.length).toBeGreaterThan(0);
      expect(contentFromOutput(streamContentEntries[0]!)).toEqual({
        kind: "agent",
        markdown: "Fallback response",
      });
    });
  });
});

async function waitForPromptType(type: PromptState["type"]): Promise<PromptState> {
  const started = Date.now();
  while (Date.now() - started < 1000) {
    const prompt = store.getPromptSnapshot();
    if (prompt?.type === type) return prompt;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(
    `Timed out waiting for ${type} prompt, have ${store.getPromptSnapshot()?.type ?? "null"}`,
  );
}

function entryText(entry: OutputEntry): string {
  return typeof entry.message === "string" ? entry.message : "";
}

describe("InkPresentationService approval rejection", () => {
  const printed: OutputEntry[] = [];
  let originalPrintOutput: (typeof store)["printOutput"];

  beforeEach(() => {
    printed.length = 0;
    originalPrintOutput = store.printOutput;
    store.printOutput = (entry: OutputEntry) => {
      printed.push(entry);
      return originalPrintOutput(entry);
    };
    store.setPrompt(null);
    store.setApprovalRequest(null);
  });

  afterEach(() => {
    store.printOutput = originalPrintOutput;
    store.setPrompt(null);
    store.setApprovalRequest(null);
  });

  function requestEditApproval() {
    const service = new InkPresentationService(DEFAULT_DISPLAY_CONFIG, null);
    return Effect.runPromise(
      service.requestApproval({
        toolCallId: "call-1",
        toolName: "edit_file",
        message: "Will rewrite src/foo.ts",
        executeToolName: "execute_edit_file",
        executeArgs: { path: "src/foo.ts" },
      }),
    );
  }

  function requestCommandApproval() {
    const service = new InkPresentationService(DEFAULT_DISPLAY_CONFIG, null);
    return Effect.runPromise(
      service.requestApproval({
        toolCallId: "call-2",
        toolName: "execute_command",
        message: "Command: rm -rf ./build",
        executeToolName: "execute_execute_command",
        executeArgs: { command: "rm -rf ./build" },
        editableArg: "command",
      }),
    );
  }

  test("a request whose caller stops takes its card back and the next request is asked", async () => {
    const service = new InkPresentationService(DEFAULT_DISPLAY_CONFIG, null);
    const chat: PromptState = { type: "chat", message: "You:", resolve: () => undefined };
    store.setPrompt(chat);
    const first = Effect.runFork(
      service.requestApproval({
        toolCallId: "call-stopped",
        toolName: "execute_command",
        message: "Command: sleep 120",
        executeToolName: "execute_execute_command",
        executeArgs: { command: "sleep 120" },
      }),
    );
    const queued = Effect.runFork(
      service.requestApproval({
        toolCallId: "call-queued-stopped",
        toolName: "execute_command",
        message: "Command: sleep 5",
        executeToolName: "execute_execute_command",
        executeArgs: { command: "sleep 5" },
      }),
    );
    await waitForPromptType("select");
    await Effect.runPromise(Fiber.interrupt(queued));
    await Effect.runPromise(Fiber.interrupt(first));
    expect(store.getPromptSnapshot()).toBe(chat);
    expect(store.getSessionSnapshot().approvalRequest).toBeNull();

    const next = Effect.runPromise(
      service.requestApproval({
        toolCallId: "call-next",
        toolName: "execute_command",
        message: "Command: ls",
        executeToolName: "execute_execute_command",
        executeArgs: { command: "ls" },
      }),
    );
    (await waitForPromptType("select")).resolve("yes");
    expect(await next).toEqual({ approved: true });
    await Effect.runPromise(service.signalToolExecutionStarted());
    expect(store.getPromptSnapshot()).toBe(chat);
    store.setPrompt(null);
  });

  test("the Ink card states the same facts and verbs as the fullscreen card", async () => {
    const service = new InkPresentationService(DEFAULT_DISPLAY_CONFIG, null);
    const pending = Effect.runPromise(
      service.requestApproval({
        toolCallId: "call-rm",
        toolName: "rm",
        message: "About to delete: /tmp/old-exports",
        executeToolName: "execute_rm",
        executeArgs: { path: "/tmp/old-exports", recursive: true },
        impact: "214 files, 1.3 GB",
      }),
    );
    const prompt = await waitForPromptType("select");
    const request = store.getSessionSnapshot().approvalRequest;
    expect(request).not.toBeNull();
    const text = renderToString(React.createElement(ApprovalView, { request: request! }), {
      columns: 100,
    });
    expect(printed).toHaveLength(0);
    expect(text).toContain("Delete");
    expect(text).toContain("can't be undone");
    expect(text).toContain("removes");
    expect(text).toContain("214 files, 1.3 GB");
    const labels = (prompt.options?.choices ?? []).map((choice) => choice.label);
    expect(labels[0]).toBe("Yes, delete");
    expect(labels.at(-1)).toBe("No, don't delete");
    prompt.resolve("no");
    (await waitForPromptType("text")).resolve("");
    await pending;
  });

  test("shows the entire long request without approving when details are opened", async () => {
    const service = new InkPresentationService(DEFAULT_DISPLAY_CONFIG, null);
    const body = "a".repeat(150) + " DO NOT SEND THIS TAIL";
    let resolved = false;
    const pending = Effect.runPromise(
      service.requestApproval({
        toolCallId: "call-long",
        toolName: "gmail_send_email",
        executeToolName: "gmail_send_email",
        message: "Send this message",
        executeArgs: { to: "a@example.com", body },
      }),
    ).then((outcome) => {
      resolved = true;
      return outcome;
    });
    const prompt = await waitForPromptType("select");
    expect(prompt.options?.choices?.some((choice) => choice.value === "view_details")).toBe(true);
    expect(store.getExpandableDiff()?.fullDiff).toContain(body);
    prompt.resolve("view_details");
    const again = await waitForPromptType("select");
    expect(resolved).toBe(false);
    expect(
      printed.some((entry) => typeof entry.message === "string" && entry.message.includes(body)),
    ).toBe(true);
    again.resolve("yes");
    expect(await pending).toEqual({ approved: true });
  });

  test("runs the approver's rewrite of an editable argument, prefilled with the original", async () => {
    const pending = requestCommandApproval();
    const approvalPrompt = await waitForPromptType("select");
    approvalPrompt.resolve("edit");

    const editor = await waitForPromptType("text");
    expect(editor.options?.["defaultValue"]).toBe("rm -rf ./build");
    editor.resolve("rm -rf ./build/cache");

    expect(await pending).toEqual({
      approved: true,
      editedArgs: { command: "rm -rf ./build/cache" },
    });
  });

  test("goes back to the same approval when the rewrite is abandoned", async () => {
    const pending = requestCommandApproval();
    (await waitForPromptType("select")).resolve("edit");
    const editor = await waitForPromptType("text");
    editor.reject?.();

    const again = await waitForPromptType("select");
    expect(store.getApprovalRequestSnapshot()?.args["command"]).toBe("rm -rf ./build");
    again.resolve("yes");
    expect(await pending).toEqual({ approved: true });
  });

  test("echoes what the user would rather do as a user turn", async () => {
    const pending = requestEditApproval();
    const approvalPrompt = await waitForPromptType("select");
    approvalPrompt.resolve("no");

    const followUp = await waitForPromptType("text");
    followUp.resolve("just add a comment");

    const outcome = await pending;
    expect(outcome).toEqual({ approved: false, userMessage: "just add a comment" });

    const userTurns = printed.filter((entry) => entry.type === "user");
    expect(userTurns).toHaveLength(1);
    expect(entryText(userTurns[0]!)).toBe("just add a comment");
  });

  test("does not echo a user turn when the follow-up is skipped", async () => {
    const pending = requestEditApproval();
    const approvalPrompt = await waitForPromptType("select");
    approvalPrompt.resolve("no");

    const followUp = await waitForPromptType("text");
    followUp.resolve("   ");

    const outcome = await pending;
    expect(outcome).toEqual({ approved: false });
    expect(printed.filter((entry) => entry.type === "user")).toHaveLength(0);
  });
});

describe("InkPresentationService sub-agent collapse line", () => {
  test("routes a batch response to the sub-agent log", async () => {
    const service = new InkPresentationService(DEFAULT_DISPLAY_CONFIG, null);
    const regionId = await Effect.runPromise(
      service.openEphemeralRegion("subagent", "Researcher", {
        agentRun: { task: "Find the answer", acceptsMessages: true },
      }),
    );
    const outputBefore = store.getOutputSnapshot().entries.length;

    await Effect.runPromise(
      service.presentAgentResponse("Researcher", "The answer is 42.", {
        ephemeralRegionId: regionId,
      }),
    );

    const run = store.getSubagentsSnapshot().runs.find((candidate) => candidate.id === regionId);
    expect(run?.entries).toEqual([
      { id: `${regionId}:entry:0`, kind: "response", text: "The answer is 42." },
    ]);
    expect(store.getOutputSnapshot().entries.length).toBe(outputBefore);
  });

  const printed: OutputEntry[] = [];
  let originalPrintOutput: (typeof store)["printOutput"];

  beforeEach(() => {
    printed.length = 0;
    originalPrintOutput = store.printOutput;
    store.printOutput = (entry: OutputEntry) => {
      printed.push(entry);
      return originalPrintOutput(entry);
    };
  });

  afterEach(() => {
    store.printOutput = originalPrintOutput;
  });

  test("carries the sub-agent's total cost and tokens into the surviving summary line", async () => {
    const service = new InkPresentationService(DEFAULT_DISPLAY_CONFIG, null);
    const regionId = await Effect.runPromise(service.openEphemeralRegion("subagent", "Researcher"));

    await Effect.runPromise(
      service.collapseEphemeralRegion(regionId, "Researcher", {
        status: "completed",
        durationMs: 12_300,
        costUSD: 0.0187,
        totalTokens: 29_400,
      }),
    );

    const summary = printed.find((entry) => entryText(entry).includes("Researcher completed"));
    expect(summary).toBeDefined();
    expect(entryText(summary!)).toContain("29k tok");
    expect(entryText(summary!)).toContain("$0.02");
  });

  test("omits cost and tokens from the summary line when the run failed", async () => {
    const service = new InkPresentationService(DEFAULT_DISPLAY_CONFIG, null);
    const regionId = await Effect.runPromise(service.openEphemeralRegion("subagent", "Researcher"));

    await Effect.runPromise(
      service.collapseEphemeralRegion(regionId, "Researcher", {
        status: "failed",
        durationMs: 4_000,
      }),
    );

    const summary = printed.find((entry) => entryText(entry).includes("Researcher failed"));
    expect(summary).toBeDefined();
    expect(entryText(summary!)).not.toContain("tok");
    expect(entryText(summary!)).not.toContain("$");
  });
});

describe("model retries", () => {
  afterEach(() => {
    store.setRetryNotice(null);
  });

  test("a scheduled retry is state with a real deadline, and the model's next words clear it", () => {
    const service = new InkPresentationService(DEFAULT_DISPLAY_CONFIG, null);
    const before = Date.now();
    Effect.runSync(
      service.presentRetry({
        agentName: "sol",
        provider: "openai",
        reason: "rate limit",
        detail: "Too Many Requests",
        statusCode: 429,
        attempt: 1,
        maxAttempts: 5,
        retryInMs: 8_000,
      }),
    );
    const notice = store.getSessionSnapshot().retryNotice;
    expect(notice?.attempt).toBe(1);
    expect(notice?.retryAt).toBeGreaterThanOrEqual(before + 8_000);

    const renderer = new InkStreamingRenderer(
      "sol",
      false,
      { showReasoning: true, showToolExecution: true, mode: "rendered", colorProfile: "full" },
      { textBufferMs: 0 },
      0,
    );
    // A new attempt opening is not an answer: it may fail and be retried again.
    Effect.runSync(
      renderer.handleEvent({ type: "stream_start", provider: "openai", model: "m", timestamp: 0 }),
    );
    expect(store.getSessionSnapshot().retryNotice).not.toBeNull();

    Effect.runSync(renderer.handleEvent({ type: "text_start" }));
    expect(store.getSessionSnapshot().retryNotice).toBeNull();
  });
});

describe("the run's interrupt handler", () => {
  const displayConfig = {
    showReasoning: true,
    showToolExecution: true,
    mode: "rendered" as const,
    colorProfile: "full" as const,
  };

  afterEach(() => {
    store.setInterruptHandler(null);
  });

  test("survives a reset and a flush, so a run that retried can still be stopped", () => {
    const renderer = new InkStreamingRenderer("sol", false, displayConfig, { textBufferMs: 0 }, 0);
    const handler = (): void => undefined;
    Effect.runSync(renderer.setInterruptHandler(handler));
    Effect.runSync(renderer.reset());
    Effect.runSync(renderer.flush());
    expect(store.getSessionSnapshot().interruptHandler).toBe(handler);
  });

  test("is never replaced or cleared by a sub-agent's renderer", () => {
    const parent = (): void => undefined;
    store.setInterruptHandler(parent);
    const child = new InkStreamingRenderer("scout", false, displayConfig, { textBufferMs: 0 }, 0, {
      kind: "ephemeral",
      regionId: "eph-child",
    });
    Effect.runSync(child.setInterruptHandler(() => undefined));
    Effect.runSync(child.setInterruptHandler(null));
    expect(store.getSessionSnapshot().interruptHandler).toBe(parent);
  });
});

describe("stopping a turn in the Ink interface", () => {
  test("prints the same done / not done summary the fullscreen block shows", () => {
    store.setChatBusy(true);
    store.printOutput({ type: "user", message: "Get Saturday sorted", timestamp: new Date() });
    store.printOutput({
      type: "log",
      message: {
        kind: "tool",
        receipt: { app: "mcp_calendar_create_event", summary: "hold placed", status: "ok" },
      },
      timestamp: new Date(),
    });
    const service = new InkPresentationService(DEFAULT_DISPLAY_CONFIG, null);
    Effect.runSync(service.presentInterrupted("sol"));
    store.flushOutputBatchNow();
    const last = store.getOutputSnapshot().entries.at(-1);
    store.setChatBusy(false);

    const content = last === undefined ? undefined : contentFromOutput(last);
    expect(content?.kind).toBe("stopped");
    const text =
      content?.kind === "stopped" ? interruptSummaryLines(content.summary).join("\n") : "";
    expect(text).toMatch(/^stopped by you after \d+\.\ds/);
    expect(text).toContain("done      mcp_calendar_create_event  hold placed");
  });
});

describe("Ink markdown, from the shared parser", () => {
  const printed: OutputEntry[] = [];
  let originalPrintOutput: (typeof store)["printOutput"];

  beforeEach(() => {
    printed.length = 0;
    originalPrintOutput = store.printOutput;
    store.printOutput = (entry: OutputEntry) => {
      printed.push(entry);
      return originalPrintOutput(entry);
    };
  });

  afterEach(() => {
    store.printOutput = originalPrintOutput;
  });

  test("styles a response the same way as fullscreen, through the shared parser", async () => {
    try {
      chalk.level = 3;
      const service = new InkPresentationService(
        { ...DEFAULT_DISPLAY_CONFIG, mode: "rendered" },
        null,
      );
      const rendered = await Effect.runPromise(
        service.renderMarkdown("**bold** and `code` and a [link](https://jazz.sh)."),
      );
      expect(rendered).toContain("\u001b]8;;https://jazz.sh\u0007");
      // eslint-disable-next-line no-control-regex -- ANSI/OSC 8 escapes are the point of this strip.
      const visible = rendered.replace(/\u001b(\[[0-9;]*m|\]8;;[^\u0007]*\u0007)/g, "");
      expect(visible).not.toContain("**");
    } finally {
      chalk.level = 0;
    }
  });

  test("never wraps a long paragraph, so Ink's own <Text wrap> can reflow it on resize", async () => {
    const service = new InkPresentationService(
      { ...DEFAULT_DISPLAY_CONFIG, mode: "rendered" },
      null,
    );
    const long = Array.from({ length: 40 }, (_, index) => `word${String(index)}`).join(" ");
    const rendered = await Effect.runPromise(service.renderMarkdown(long));
    expect(rendered.split("\n")).toHaveLength(1);
  });

  test("hybrid mode keeps the markdown syntax visible", async () => {
    const service = new InkPresentationService({ ...DEFAULT_DISPLAY_CONFIG, mode: "hybrid" }, null);
    const rendered = await Effect.runPromise(service.renderMarkdown("**bold**"));
    expect(rendered).toContain("**bold**");
  });

  test("raw mode passes text through untouched", async () => {
    const service = new InkPresentationService({ ...DEFAULT_DISPLAY_CONFIG, mode: "raw" }, null);
    const rendered = await Effect.runPromise(service.renderMarkdown("**bold**"));
    expect(rendered).toBe("**bold**");
  });

  test("a settled agent response reads through the same pipeline", async () => {
    const service = new InkPresentationService(
      { ...DEFAULT_DISPLAY_CONFIG, mode: "rendered" },
      null,
    );
    await Effect.runPromise(service.presentAgentResponse("sol", "**bold** answer"));
    const response = printed.find((entry) => contentFromOutput(entry).kind === "agent");
    expect(response).toBeDefined();
    expect(response!.message).toEqual({ kind: "agent", markdown: "**bold** answer" });
    const painted = renderToString(
      React.createElement(OutputEntryView, {
        entry: { ...response!, id: "response" },
        addSpacing: false,
      }),
    );
    expect(painted).toContain("bold");
    expect(painted).not.toContain("**");
  });
});
