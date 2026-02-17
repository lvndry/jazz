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
    test("emits info + tip logs, stores provider/model, returns no activity", () => {
      const a = acc();
      const result = reduceEvent(
        a,
        { type: "stream_start", provider: "openai", model: "gpt-4", timestamp: Date.now() },
        identity,
        stubInk,
      );

      expect(result.activity).toBeNull();
      expect(result.outputs).toHaveLength(2);
      expect(result.outputs[0]!.type).toBe("info");
      expect(result.outputs[0]!.message).toContain("TestAgent");
      expect(result.outputs[0]!.message).toContain("openai/gpt-4");
      expect(result.outputs[1]!.type).toBe("log");
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

    test("thinking_chunk returns thinking phase with reasoning", () => {
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
        expect(result.activity!.reasoning).toBe("deep thought");
      }
    });

    test("thinking_complete logs reasoning, accumulates completedReasoning", () => {
      const a = acc({ isThinking: true, reasoningBuffer: "some reasoning" });
      const result = reduceEvent(a, { type: "thinking_complete" }, identity, stubInk);

      expect(a.isThinking).toBe(false);
      expect(a.reasoningBuffer).toBe("");
      expect(a.completedReasoning).toBe("some reasoning");
      // Should emit a reasoning log (rendered as Ink element)
      expect(result.outputs.length).toBeGreaterThan(0);
      expect(result.outputs[0]!.type).toBe("log");
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

    test("text_start enters streaming phase and emits a response header", () => {
      const a = acc({ completedReasoning: "thought" });
      const result = reduceEvent(a, { type: "text_start" }, identity, stubInk);

      expect(result.activity).not.toBeNull();
      expect(result.activity!.phase).toBe("streaming");
      expect(result.outputs.length).toBeGreaterThan(0);
    });

    test("text_chunk updates liveText and returns streaming activity", () => {
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
      if (result.activity!.phase === "streaming") {
        expect(result.activity!.text).toBe("Hi");
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
  // text memory limits
  // -------------------------------------------------------------------------

  describe("text memory limits", () => {
    test("caps liveText to MAX_LIVE_TEXT_LENGTH (200k)", () => {
      const a = acc();
      reduceEvent(a, { type: "text_start" }, identity, stubInk);

      // Build a string exceeding 200k
      const bigText = "x".repeat(250_000);
      reduceEvent(
        a,
        { type: "text_chunk", delta: bigText, accumulated: bigText, sequence: 0 },
        identity,
        stubInk,
      );

      expect(a.liveText.length).toBe(200_000);
      // Should keep the tail (most recent content)
      expect(a.liveText).toBe(bigText.slice(-200_000));
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
      // text_chunk → streaming
      const r6 = reduceEvent(
        a,
        { type: "text_chunk", delta: "Hi", accumulated: "Hi", sequence: 0 },
        identity,
        stubInk,
      );
      expect(r6.activity!.phase).toBe("streaming");
      if (r6.activity!.phase === "streaming") {
        expect(r6.activity!.text).toBe("Hi");
        expect(r6.activity!.reasoning).toBe("hmm");
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
    test("flushed paragraphs are plain strings with left padding", () => {
      const { render } = createCapturingInk();
      const a = acc();
      const r1 = reduceEvent(a, { type: "text_start" }, identity, render);

      // Accumulate enough text to trigger a flush (>4000 chars)
      const longText = "A".repeat(5000) + "\n\n" + "B".repeat(100);
      const r2 = reduceEvent(
        a,
        { type: "text_chunk", delta: longText, accumulated: longText, sequence: 0 },
        identity,
        render,
      );

      // Flushed output should be a plain string (not an Ink node), padded with 2 spaces
      const allOutputs = [...r1.outputs, ...r2.outputs];
      const flushedEntry = allOutputs.find(
        (e) => e.type === "log" && typeof e.message === "string" && e.message.startsWith("  "),
      );
      expect(flushedEntry).toBeDefined();
      expect(typeof flushedEntry!.message).toBe("string");
    });

    test("reasoning text container uses flexDirection column on inner Box", () => {
      const { nodes, render } = createCapturingInk();
      const a = acc({ isThinking: true, reasoningBuffer: "some deep thought" });
      reduceEvent(a, { type: "thinking_complete" }, identity, render);

      // The reasoning output should have an inner Box with flexDirection column
      // wrapping the reasoning Text with wrap="truncate"
      expect(nodes.length).toBeGreaterThan(0);
      const reasoningRoot = nodes[0]!;

      const innerBox = findElement(reasoningRoot, (p) => {
        return p["paddingLeft"] === 1 && p["flexDirection"] === "column";
      });
      expect(innerBox).toBeDefined();

      // The Text inside should have wrap="truncate" and dimColor
      const textEl = findElement(
        innerBox!,
        (p) => p["wrap"] === "truncate" && p["dimColor"] === true,
      );
      expect(textEl).not.toBeNull();
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

    test("streaming activity text is displayed with correct formatting", () => {
      const a = acc();
      reduceEvent(a, { type: "text_start" }, identity, stubInk);
      const result = reduceEvent(
        a,
        { type: "text_chunk", delta: "Hello world", accumulated: "Hello world", sequence: 0 },
        identity,
        stubInk,
      );

      // Verify the activity has the formatted text
      expect(result.activity!.phase).toBe("streaming");
      if (result.activity!.phase === "streaming") {
        expect(result.activity!.text).toBe("Hello world");
      }
    });
  });
});
