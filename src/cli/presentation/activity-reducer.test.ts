import { describe, expect, test } from "bun:test";
import React from "react";
import { createAccumulator, reduceEvent } from "./activity-reducer";
import type { ReducerAccumulator } from "./activity-reducer";

/** Identity formatter — returns text unchanged so assertions are straightforward. */
const identity = (s: string) => s;

/** Stub ink renderer — returns the string tag for assertions. */
const stubInk = (node: unknown) => `[ink:${typeof node}]`;

/**
 * Capturing ink renderer — stores React elements for structural assertions.
 * Returns the captured nodes array alongside the stub function.
 */
function createCapturingInk() {
  const nodes: React.ReactElement[] = [];
  const render = (node: unknown) => {
    if (React.isValidElement(node)) {
      nodes.push(node);
    }
    return `[ink:${typeof node}]`;
  };
  return { nodes, render };
}

/**
 * Recursively find the first React element in the tree whose props match the predicate.
 */
function findElement(
  el: React.ReactElement,
  predicate: (props: Record<string, unknown>) => boolean,
): React.ReactElement | null {
  const props = el.props as Record<string, unknown>;
  if (predicate(props)) return el;

  const children = props["children"];
  if (React.isValidElement(children)) {
    const found = findElement(children, predicate);
    if (found) return found;
  }
  if (Array.isArray(children)) {
    for (const child of children) {
      if (React.isValidElement(child)) {
        const found = findElement(child, predicate);
        if (found) return found;
      }
    }
  }
  return null;
}

function extractText(node: unknown): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (!React.isValidElement(node)) return "";
  const props = node.props as { children?: unknown };
  const children = props.children;
  if (Array.isArray(children)) {
    return children.map((child) => extractText(child)).join("");
  }
  return extractText(children);
}

function acc(overrides?: Partial<ReducerAccumulator>): ReducerAccumulator {
  return { ...createAccumulator("TestAgent"), ...overrides };
}

describe("activity-reducer", () => {
  // -------------------------------------------------------------------------
  // createAccumulator
  // -------------------------------------------------------------------------

  describe("createAccumulator", () => {
    test("initializes with correct defaults", () => {
      const a = createAccumulator("Agent");
      expect(a.agentName).toBe("Agent");
      expect(a.liveText).toBe("");
      expect(a.reasoningBuffer).toBe("");
      expect(a.completedReasoning).toBe("");
      expect(a.isThinking).toBe(false);
      expect(a.lastAgentHeaderWritten).toBe(false);
      expect(a.lastAppliedTextSequence).toBe(-1);
      expect(a.activeTools.size).toBe(0);
      expect(a.currentProvider).toBeNull();
      expect(a.currentModel).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // stream_start
  // -------------------------------------------------------------------------

  describe("stream_start", () => {
    test("emits info log, stores provider/model, returns no activity", () => {
      const a = acc();
      const result = reduceEvent(
        a,
        { type: "stream_start", provider: "openai", model: "gpt-4", timestamp: Date.now() },
        identity,
        stubInk,
      );

      expect(result.activity).toBeNull();
      expect(result.outputs).toHaveLength(1);
      expect(result.outputs[0]!.type).toBe("info");
      expect(result.outputs[0]!.message).toContain("TestAgent");
      expect(result.outputs[0]!.message).toContain("openai/gpt-4");
      expect(a.lastAgentHeaderWritten).toBe(true);
      expect(a.currentProvider).toBe("openai");
      expect(a.currentModel).toBe("gpt-4");
    });
  });

  // -------------------------------------------------------------------------
  // thinking lifecycle
  // -------------------------------------------------------------------------

  describe("thinking lifecycle", () => {
    test("thinking_start sets phase to thinking", () => {
      const a = acc();
      const result = reduceEvent(
        a,
        { type: "thinking_start", provider: "test" },
        identity,
        stubInk,
      );

      expect(a.isThinking).toBe(true);
      expect(result.activity).not.toBeNull();
      expect(result.activity!.phase).toBe("thinking");
    });

    test("thinking_chunk appends to reasoning buffer", () => {
      const a = acc({ isThinking: true });
      reduceEvent(a, { type: "thinking_chunk", content: "Hello ", sequence: 0 }, identity, stubInk);
      reduceEvent(a, { type: "thinking_chunk", content: "world", sequence: 1 }, identity, stubInk);

      expect(a.reasoningBuffer).toBe("Hello world");
    });

    test("thinking_chunk returns thinking phase without reasoning", () => {
      const a = acc({ isThinking: true });
      const result = reduceEvent(
        a,
        { type: "thinking_chunk", content: "deep thought", sequence: 0 },
        identity,
        stubInk,
      );

      expect(result.activity).not.toBeNull();
      expect(result.activity!.phase).toBe("thinking");
      if (result.activity!.phase === "thinking") {
        expect(result.activity!.reasoning).toBe("");
      }
    });

    test("thinking_complete accumulates completedReasoning without logging", () => {
      const a = acc({ isThinking: true, reasoningBuffer: "some reasoning" });
      const result = reduceEvent(a, { type: "thinking_complete" }, identity, stubInk);

      expect(a.isThinking).toBe(false);
      expect(a.reasoningBuffer).toBe("");
      expect(a.completedReasoning).toBe("some reasoning");
      expect(result.outputs.length).toBe(0);
    });

    test("thinking_complete with empty buffer does not log", () => {
      const a = acc({ isThinking: true, reasoningBuffer: "   " });
      const result = reduceEvent(a, { type: "thinking_complete" }, identity, stubInk);

      expect(result.outputs).toHaveLength(0);
    });

    test("multiple thinking sessions accumulate reasoning with separator", () => {
      const a = acc();

      // First session
      a.isThinking = true;
      a.reasoningBuffer = "first";
      reduceEvent(a, { type: "thinking_complete" }, identity, stubInk);

      // Second session
      a.isThinking = true;
      a.reasoningBuffer = "second";
      reduceEvent(a, { type: "thinking_complete" }, identity, stubInk);

      expect(a.completedReasoning).toContain("first");
      expect(a.completedReasoning).toContain("---");
      expect(a.completedReasoning).toContain("second");
    });
  });

  // -------------------------------------------------------------------------
  // text lifecycle
  // -------------------------------------------------------------------------

  describe("text lifecycle", () => {
    test("text_start resets liveText and sequence", () => {
      const a = acc({ liveText: "old", lastAppliedTextSequence: 5 });
      reduceEvent(a, { type: "text_start" }, identity, stubInk);

      expect(a.liveText).toBe("");
      expect(a.lastAppliedTextSequence).toBe(-1);
    });

    test("text_start enters streaming phase, emits reasoning separator when reasoning exists", () => {
      const a = acc({ completedReasoning: "thought" });
      const result = reduceEvent(a, { type: "text_start" }, identity, stubInk);

      expect(result.activity).not.toBeNull();
      expect(result.activity!.phase).toBe("streaming");
      // Only the reasoning separator is emitted (no "is responding" header)
      expect(result.outputs).toHaveLength(1);
      expect(result.outputs[0]!.type).toBe("log");
    });

    test("text_start emits no outputs when no reasoning was produced", () => {
      const a = acc();
      const result = reduceEvent(a, { type: "text_start" }, identity, stubInk);

      expect(result.activity).not.toBeNull();
      expect(result.activity!.phase).toBe("streaming");
      expect(result.outputs).toHaveLength(0);
    });

    test("text_chunk updates liveText and returns streaming activity without live text", () => {
      const a = acc();
      reduceEvent(a, { type: "text_start" }, identity, stubInk);
      const result = reduceEvent(
        a,
        { type: "text_chunk", delta: "Hi", accumulated: "Hi", sequence: 0 },
        identity,
        stubInk,
      );

      expect(a.liveText).toBe("Hi");
      expect(result.activity!.phase).toBe("streaming");
      // Streaming text is appended directly to output entries, not the activity area
      if (result.activity!.phase === "streaming") {
        expect(result.activity!.text).toBe("");
      }
    });

    test("text_chunk ignores stale sequence", () => {
      const a = acc({ liveText: "Hello", lastAppliedTextSequence: 3 });
      reduceEvent(
        a,
        { type: "text_chunk", delta: "H", accumulated: "H", sequence: 1 },
        identity,
        stubInk,
      );

      expect(a.liveText).toBe("Hello");
      expect(a.lastAppliedTextSequence).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // text accumulation (no truncation)
  // -------------------------------------------------------------------------

  describe("text accumulation", () => {
    test("liveText accumulates fully without truncation", () => {
      const a = acc();
      reduceEvent(a, { type: "text_start" }, identity, stubInk);

      // Build a string exceeding 200k — should be kept in full
      const bigText = "x".repeat(250_000);
      reduceEvent(
        a,
        { type: "text_chunk", delta: bigText, accumulated: bigText, sequence: 0 },
        identity,
        stubInk,
      );

      expect(a.liveText.length).toBe(250_000);
      expect(a.liveText).toBe(bigText);
    });
  });

  // -------------------------------------------------------------------------
  // tool execution
  // -------------------------------------------------------------------------

  describe("tool execution", () => {
    test("tool_execution_start adds tool and returns tool-execution phase", () => {
      const a = acc();
      const result = reduceEvent(
        a,
        {
          type: "tool_execution_start",
          toolName: "execute_bash",
          toolCallId: "tc-1",
          arguments: { command: "ls" },
        },
        identity,
        stubInk,
      );

      expect(a.activeTools.get("tc-1")?.toolName).toBe("execute_bash");
      expect(result.activity!.phase).toBe("tool-execution");
      if (result.activity!.phase === "tool-execution") {
        expect(result.activity!.tools).toHaveLength(1);
        expect(result.activity!.tools[0]!.toolName).toBe("execute_bash");
      }
      expect(result.outputs.length).toBeGreaterThan(0);
      expect(result.outputs[0]!.type).toBe("log");
    });

    test("tool_execution_complete removes tool and transitions to idle when last", () => {
      const a = acc();
      a.activeTools.set("tc-1", { toolName: "execute_bash", startedAt: Date.now() });

      const result = reduceEvent(
        a,
        {
          type: "tool_execution_complete",
          toolCallId: "tc-1",
          result: "ok",
          durationMs: 42,
        },
        identity,
        stubInk,
      );

      expect(a.activeTools.size).toBe(0);
      expect(result.activity!.phase).toBe("idle");
      expect(result.outputs.length).toBeGreaterThan(0);
      expect(result.outputs[0]!.type).toBe("log");
    });

    test("tool_execution_complete keeps tool-execution phase when other tools remain", () => {
      const a = acc();
      a.activeTools.set("tc-1", { toolName: "bash", startedAt: Date.now() });
      a.activeTools.set("tc-2", { toolName: "read", startedAt: Date.now() });

      const result = reduceEvent(
        a,
        {
          type: "tool_execution_complete",
          toolCallId: "tc-1",
          result: "ok",
          durationMs: 10,
        },
        identity,
        stubInk,
      );

      expect(a.activeTools.size).toBe(1);
      expect(result.activity!.phase).toBe("tool-execution");
    });

    test("tool_execution_complete with multi-line summary emits two logs", () => {
      const a = acc();
      a.activeTools.set("tc-1", { toolName: "diff_tool", startedAt: Date.now() });

      const result = reduceEvent(
        a,
        {
          type: "tool_execution_complete",
          toolCallId: "tc-1",
          result: "ok",
          durationMs: 10,
          summary: "line1\nline2",
        },
        identity,
        stubInk,
      );

      expect(result.outputs).toHaveLength(3);
      expect(result.outputs[0]!.type).toBe("log");
      expect(result.outputs[1]!.type).toBe("log");
      // Third log is the spacing entry
      expect(result.outputs[2]!.message).toBe("");
    });

    test("manage_todos tool execution exposes todo snapshot in activity", () => {
      const a = acc();
      const result = reduceEvent(
        a,
        {
          type: "tool_execution_start",
          toolName: "manage_todos",
          toolCallId: "todo-1",
          arguments: {
            todos: [
              { content: "Check status", status: "completed", priority: "high" },
              { content: "Push branch", status: "in_progress", priority: "medium" },
            ],
          },
        },
        identity,
        stubInk,
      );

      expect(result.activity).not.toBeNull();
      const activity = result.activity;
      expect(activity?.phase).toBe("tool-execution");
      if (activity?.phase === "tool-execution") {
        expect(activity.todoSnapshot).toHaveLength(2);
        expect(activity.todoSnapshot?.[0]?.status).toBe("completed");
      }
    });

    test("manage_todos completion prints checklist snapshot", () => {
      const a = acc();
      const { nodes, render } = createCapturingInk();
      a.activeTools.set("todo-1", {
        toolName: "manage_todos",
        startedAt: Date.now(),
        todoSnapshot: [
          { content: "Check status", status: "completed" },
          { content: "Push branch", status: "in_progress" },
        ],
      });

      const result = reduceEvent(
        a,
        {
          type: "tool_execution_complete",
          toolCallId: "todo-1",
          result: JSON.stringify({ ok: true }),
          durationMs: 10,
        },
        identity,
        render,
      );

      expect(result.outputs).toHaveLength(3);
      const outputText = nodes.map((node) => extractText(node)).join("\n");
      expect(outputText).toContain("✓ Check status");
      expect(outputText).toContain("◐ Push branch");
    });
  });

  // -------------------------------------------------------------------------
  // tools_detected
  // -------------------------------------------------------------------------

  describe("tools_detected", () => {
    test("emits info log with tool names", () => {
      const a = acc();
      const result = reduceEvent(
        a,
        {
          type: "tools_detected",
          toolNames: ["bash", "read"],
          toolsRequiringApproval: ["bash"],
          agentName: "TestAgent",
        },
        identity,
        stubInk,
      );

      expect(result.activity).toBeNull();
      expect(result.outputs).toHaveLength(1);
      expect(result.outputs[0]!.type).toBe("info");
    });
  });

  // -------------------------------------------------------------------------
  // error
  // -------------------------------------------------------------------------

  describe("error", () => {
    test("transitions to error phase and emits error log", () => {
      const a = acc();
      const error = { _tag: "LLMError" as const, message: "rate limited", name: "LLMError" };
      const result = reduceEvent(
        a,
        { type: "error", error, recoverable: false },
        identity,
        stubInk,
      );

      expect(result.activity!.phase).toBe("error");
      if (result.activity!.phase === "error") {
        expect(result.activity!.message).toBe("rate limited");
      }
      expect(result.outputs).toHaveLength(1);
      expect(result.outputs[0]!.type).toBe("error");
    });
  });

  // -------------------------------------------------------------------------
  // complete
  // -------------------------------------------------------------------------

  describe("complete", () => {
    test("transitions to complete phase with no logs", () => {
      const a = acc();
      const result = reduceEvent(
        a,
        {
          type: "complete",
          response: { content: "", role: "assistant", usage: undefined, toolCalls: [] },
          totalDurationMs: 100,
        },
        identity,
        stubInk,
      );

      expect(result.activity).toEqual({ phase: "complete" });
      expect(result.outputs).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // usage_update — no-op
  // -------------------------------------------------------------------------

  describe("usage_update", () => {
    test("returns no activity and no logs", () => {
      const a = acc();
      const result = reduceEvent(
        a,
        {
          type: "usage_update",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        },
        identity,
        stubInk,
      );

      expect(result.activity).toBeNull();
      expect(result.outputs).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Full lifecycle: thinking → text → complete
  // -------------------------------------------------------------------------

  describe("full lifecycle", () => {
    test("thinking → text produces correct phase transitions", () => {
      const a = acc();

      // stream_start
      const r1 = reduceEvent(
        a,
        { type: "stream_start", provider: "p", model: "m", timestamp: 0 },
        identity,
        stubInk,
      );
      expect(r1.activity).toBeNull();

      // thinking_start → thinking phase
      const r2 = reduceEvent(a, { type: "thinking_start", provider: "p" }, identity, stubInk);
      expect(r2.activity!.phase).toBe("thinking");

      // thinking_chunk
      reduceEvent(a, { type: "thinking_chunk", content: "hmm", sequence: 0 }, identity, stubInk);

      // thinking_complete
      reduceEvent(a, { type: "thinking_complete" }, identity, stubInk);

      // text_start — now enters streaming immediately (even before first chunk)
      const r5 = reduceEvent(a, { type: "text_start" }, identity, stubInk);
      expect(r5.activity!.phase).toBe("streaming");
      // text_chunk → streaming (response text is not shown in activity)
      const r6 = reduceEvent(
        a,
        { type: "text_chunk", delta: "Hi", accumulated: "Hi", sequence: 0 },
        identity,
        stubInk,
      );
      expect(r6.activity!.phase).toBe("streaming");
      if (r6.activity!.phase === "streaming") {
        expect(r6.activity!.text).toBe("");
        // Completed reasoning was already logged to Static output, so it is
        // NOT carried into the streaming activity (avoids on-screen duplication).
        expect(r6.activity!.reasoning).toBe("");
      }

      // complete
      const r7 = reduceEvent(
        a,
        {
          type: "complete",
          response: { content: "Hi", role: "assistant", usage: undefined, toolCalls: [] },
          totalDurationMs: 50,
        },
        identity,
        stubInk,
      );
      expect(r7.activity!.phase).toBe("complete");
    });
  });

  // -------------------------------------------------------------------------
  describe("text container layout (flexDirection column)", () => {
    test("long text does not appear in activity state during streaming", () => {
      const { render } = createCapturingInk();
      const a = acc();
      reduceEvent(a, { type: "text_start" }, identity, render);

      // Even very long text should NOT appear in activity state
      const longText = "A".repeat(5000) + "\n\n" + "B".repeat(100);
      const r2 = reduceEvent(
        a,
        { type: "text_chunk", delta: longText, accumulated: longText, sequence: 0 },
        identity,
        render,
      );

      // No streamContent outputs — all text stays in activity.text
      const flushedEntry = r2.outputs.find((e) => e.type === "streamContent");
      expect(flushedEntry).toBeUndefined();

      // Activity should be streaming but without response text
      expect(r2.activity).not.toBeNull();
      expect(r2.activity!.phase).toBe("streaming");
      if (r2.activity!.phase === "streaming") {
        expect(r2.activity!.text).toBe("");
      }
    });

    test("multi-line tool result uses flexDirection column on wrapping Box", () => {
      const { nodes, render } = createCapturingInk();
      const a = acc();
      a.activeTools.set("tc-1", { toolName: "diff_tool", startedAt: Date.now() });

      reduceEvent(
        a,
        {
          type: "tool_execution_complete",
          toolCallId: "tc-1",
          result: "ok",
          durationMs: 10,
          summary: "line1\nline2\nline3",
        },
        identity,
        render,
      );

      // Find the Box with paddingLeft=4 and flexDirection column (multi-line result container)
      const resultBox = nodes.find((el) => {
        const props = el.props as Record<string, unknown>;
        return props["paddingLeft"] === 4 && props["flexDirection"] === "column";
      });
      expect(resultBox).toBeDefined();

      // The child Text should have wrap="truncate"
      const textEl = findElement(resultBox!, (p) => p["wrap"] === "truncate");
      expect(textEl).not.toBeNull();
    });

    test("short streaming text does not appear in activity.text", () => {
      const a = acc();
      reduceEvent(a, { type: "text_start" }, identity, stubInk);
      const result = reduceEvent(
        a,
        { type: "text_chunk", delta: "Hello world", accumulated: "Hello world", sequence: 0 },
        identity,
        stubInk,
      );

      // Response text is appended by the renderer, not stored in activity.text
      expect(result.activity!.phase).toBe("streaming");
      if (result.activity!.phase === "streaming") {
        expect(result.activity!.text).toBe("");
      }
    });
  });

  // -------------------------------------------------------------------------
  // CRITICAL REGRESSION TESTS: reducer never emits output for streaming text
  // -------------------------------------------------------------------------
  // These tests guard the core invariant: the reducer does NOT emit output
  // entries for streaming text; the renderer handles append-only output.
  // -------------------------------------------------------------------------

  describe("streaming text never produces output entries", () => {
    test("text_chunk produces zero output entries (short text)", () => {
      const a = acc();
      reduceEvent(a, { type: "text_start" }, identity, stubInk);
      const result = reduceEvent(
        a,
        { type: "text_chunk", delta: "Hello", accumulated: "Hello", sequence: 0 },
        identity,
        stubInk,
      );

      expect(result.outputs).toHaveLength(0);
    });

    test("text_chunk produces zero output entries (long text)", () => {
      const a = acc();
      reduceEvent(a, { type: "text_start" }, identity, stubInk);
      const longText = "word ".repeat(1000).trim();
      const result = reduceEvent(
        a,
        { type: "text_chunk", delta: longText, accumulated: longText, sequence: 0 },
        identity,
        stubInk,
      );

      expect(result.outputs).toHaveLength(0);
    });

    test("many sequential text_chunks all produce zero output entries", () => {
      const a = acc();
      reduceEvent(a, { type: "text_start" }, identity, stubInk);

      // Simulate 50 tokens arriving one at a time (real streaming)
      let accumulated = "";
      for (let i = 0; i < 50; i++) {
        const token = `token${i} `;
        accumulated += token;
        const result = reduceEvent(
          a,
          { type: "text_chunk", delta: token, accumulated, sequence: i },
          identity,
          stubInk,
        );

        // EVERY text_chunk must produce zero outputs
        expect(result.outputs).toHaveLength(0);
        // And must always return a streaming activity with text
        expect(result.activity).not.toBeNull();
        expect(result.activity!.phase).toBe("streaming");
      }

      // Final accumulated text should be in liveText
      expect(a.liveText).toBe(accumulated);
    });

    test("text_chunk never produces streamContent output entries regardless of text size", () => {
      const a = acc();
      reduceEvent(a, { type: "text_start" }, identity, stubInk);

      // Try various sizes that might previously have triggered flush thresholds
      const sizes = [100, 500, 2000, 4000, 5000, 10000, 50000];
      for (const size of sizes) {
        const text = "x".repeat(size);
        const result = reduceEvent(
          a,
          { type: "text_chunk", delta: text, accumulated: text, sequence: size },
          identity,
          stubInk,
        );

        const streamContentEntries = result.outputs.filter((e) => e.type === "streamContent");
        expect(streamContentEntries).toHaveLength(0);
      }
    });
  });

  describe("reducer does not format streaming text", () => {
    test("activity.text remains empty for streaming text", () => {
      const markerFormatter = (s: string) => `<<FORMATTED>>${s}<<END>>`;
      const a = acc();
      reduceEvent(a, { type: "text_start" }, markerFormatter, stubInk);

      const result = reduceEvent(
        a,
        { type: "text_chunk", delta: "hello world", accumulated: "hello world", sequence: 0 },
        markerFormatter,
        stubInk,
      );

      expect(result.activity!.phase).toBe("streaming");
      if (result.activity!.phase === "streaming") {
        expect(result.activity!.text).toBe("");
      }
    });
  });
});
