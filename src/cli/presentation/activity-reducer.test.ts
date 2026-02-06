import { describe, expect, test } from "bun:test";
import type { StreamEvent } from "@/core/types/streaming";
import { createAccumulator, reduceEvent } from "./activity-reducer";
import type { ReducerAccumulator } from "./activity-reducer";

/** Identity formatter — returns text unchanged so assertions are straightforward. */
const identity = (s: string) => s;

/** Stub ink renderer — returns the string tag for assertions. */
const stubInk = (node: unknown) => `[ink:${typeof node}]`;

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
      expect(result.logs).toHaveLength(2);
      expect(result.logs[0]!.type).toBe("info");
      expect(result.logs[0]!.message).toContain("TestAgent");
      expect(result.logs[0]!.message).toContain("openai/gpt-4");
      expect(result.logs[1]!.type).toBe("log");
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
      const result = reduceEvent(a, { type: "thinking_start", provider: "test" }, identity, stubInk);

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
      // Should emit a reasoning log
      expect(result.logs.length).toBeGreaterThan(0);
      expect(result.logs[0]!.message).toContain("Reasoning");
    });

    test("thinking_complete with empty buffer does not log", () => {
      const a = acc({ isThinking: true, reasoningBuffer: "   " });
      const result = reduceEvent(a, { type: "thinking_complete" }, identity, stubInk);

      expect(result.logs).toHaveLength(0);
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

    test("text_start transitions to streaming when completedReasoning exists", () => {
      const a = acc({ completedReasoning: "thought" });
      const result = reduceEvent(a, { type: "text_start" }, identity, stubInk);

      // No liveText yet, so should be thinking phase
      expect(result.activity!.phase).toBe("thinking");
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

      expect(a.activeTools.get("tc-1")).toBe("execute_bash");
      expect(result.activity!.phase).toBe("tool-execution");
      if (result.activity!.phase === "tool-execution") {
        expect(result.activity!.tools).toHaveLength(1);
        expect(result.activity!.tools[0]!.toolName).toBe("execute_bash");
      }
      expect(result.logs.length).toBeGreaterThan(0);
      expect(result.logs[0]!.message).toContain("execute_bash");
    });

    test("tool_execution_complete removes tool and transitions to idle when last", () => {
      const a = acc();
      a.activeTools.set("tc-1", "execute_bash");

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
      expect(result.logs.length).toBeGreaterThan(0);
      expect(result.logs[0]!.type).toBe("success");
    });

    test("tool_execution_complete keeps tool-execution phase when other tools remain", () => {
      const a = acc();
      a.activeTools.set("tc-1", "bash");
      a.activeTools.set("tc-2", "read");

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
      a.activeTools.set("tc-1", "diff_tool");

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

      expect(result.logs).toHaveLength(2);
      expect(result.logs[0]!.type).toBe("success");
      expect(result.logs[1]!.type).toBe("log");
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
      expect(result.logs).toHaveLength(1);
      expect(result.logs[0]!.type).toBe("info");
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
      expect(result.logs).toHaveLength(1);
      expect(result.logs[0]!.type).toBe("error");
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
      expect(result.logs).toHaveLength(0);
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
      expect(result.logs).toHaveLength(0);
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

      // text_start — still thinking (no liveText yet)
      const r5 = reduceEvent(a, { type: "text_start" }, identity, stubInk);
      expect(r5.activity!.phase).toBe("thinking");

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
});
