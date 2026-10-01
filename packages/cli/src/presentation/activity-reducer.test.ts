import type { ChatCompletionResponse } from "@jazz/core/types/chat";
import { LLMRequestError } from "@jazz/core/types/errors";
import { describe, expect, test } from "bun:test";
import { AWAITING_LABELS, createAccumulator, reduceEvent } from "./activity-reducer";
import type { ReducerAccumulator } from "./activity-reducer";
import { contentFromOutput } from "../ui/document";
import { getGlyphs } from "../ui/glyphs";
import { receiptParts } from "../ui/models/receipt";
import type { OutputEntry } from "../ui/types";

/** Assertions inspect source facts; renderer parity is covered by receipt.test.tsx. */
function receipt(entry: OutputEntry | undefined) {
  if (entry === undefined) return undefined;
  const content = contentFromOutput(entry);
  return content.kind === "tool" ? content.receipt : undefined;
}
function outputText(entry: OutputEntry | undefined): string {
  if (entry === undefined) return "";
  const content = contentFromOutput(entry);
  if (content.kind === "notice" || content.kind === "user") return content.text;
  if (content.kind === "tool")
    return [
      content.receipt.app,
      ...receiptParts(content.receipt, getGlyphs()).map((part) => part.text),
    ].join(" ");
  return "";
}

function acc(overrides?: Partial<ReducerAccumulator>): ReducerAccumulator {
  return { ...createAccumulator("TestAgent"), ...overrides };
}

function completeResponse(content: string): ChatCompletionResponse {
  return { id: "test", model: "gpt-4", content, toolCalls: [] };
}

describe("activity-reducer", () => {
  // -------------------------------------------------------------------------
  // createAccumulator
  // -------------------------------------------------------------------------

  describe("createAccumulator", () => {
    test("initializes with correct defaults", () => {
      const a = createAccumulator("Agent");
      expect(a.agentName).toBe("Agent");
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
    test("emits agent turn header, stores provider/model, transitions to awaiting phase", () => {
      const a = acc();
      const result = reduceEvent(a, {
        type: "stream_start",
        provider: "openai",
        model: "gpt-4",
        timestamp: Date.now(),
      });

      expect(result.activity).not.toBeNull();
      const activity = result.activity;
      expect(activity?.phase).toBe("awaiting");
      if (activity?.phase === "awaiting") {
        expect(activity.agentName).toBe("TestAgent");
        expect(activity.provider).toBe("openai");
        expect(activity.model).toBe("gpt-4");
        expect(AWAITING_LABELS).toContain(activity.label);
      }
      expect(result.outputs).toHaveLength(1);
      expect(result.outputs[0]!.type).toBe("log");
      expect(result.outputs[0]?.message).toEqual({
        kind: "header",
        name: "TestAgent",
        provider: "openai",
        model: "gpt-4",
      });
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
      const result = reduceEvent(a, { type: "thinking_start", provider: "test" });

      expect(a.isThinking).toBe(true);
      expect(result.activity).not.toBeNull();
      expect(result.activity!.phase).toBe("thinking");
    });

    test("thinking_chunk returns thinking phase", () => {
      const a = acc({ isThinking: true });
      const result = reduceEvent(a, {
        type: "thinking_chunk",
        content: "deep thought",
        sequence: 0,
      });

      expect(result.activity).not.toBeNull();
      expect(result.activity!.phase).toBe("thinking");
    });

    test("thinking_complete transitions to thinking phase and emits no outputs", () => {
      const a = acc({ isThinking: true });
      const result = reduceEvent(a, { type: "thinking_complete" });

      expect(a.isThinking).toBe(false);
      expect(result.outputs.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // text lifecycle
  // -------------------------------------------------------------------------

  describe("text lifecycle", () => {
    test("text_start resets sequence", () => {
      const a = acc({ lastAppliedTextSequence: 5 });
      reduceEvent(a, { type: "text_start" });

      expect(a.lastAppliedTextSequence).toBe(-1);
    });

    test("text_start enters streaming phase and emits no outputs", () => {
      const a = acc();
      const result = reduceEvent(a, { type: "text_start" });

      expect(result.activity).not.toBeNull();
      expect(result.activity!.phase).toBe("streaming");
      expect(result.outputs).toHaveLength(0);
    });

    test("text_chunk returns streaming activity without live text in activity", () => {
      const a = acc();
      reduceEvent(a, { type: "text_start" });
      const result = reduceEvent(a, {
        type: "text_chunk",
        delta: "Hi",
        accumulated: "Hi",
        sequence: 0,
      });

      expect(result.activity!.phase).toBe("streaming");
      // Streaming text is appended directly to output entries, not the activity area
      if (result.activity!.phase === "streaming") {
        expect(result.activity!.text).toBe("");
      }
    });

    test("text_chunk ignores stale sequence", () => {
      const a = acc({ lastAppliedTextSequence: 3 });
      reduceEvent(a, { type: "text_chunk", delta: "H", accumulated: "H", sequence: 1 });

      expect(a.lastAppliedTextSequence).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // tool execution
  // -------------------------------------------------------------------------

  describe("tool execution", () => {
    test("tool_execution_start adds tool and returns tool-execution phase", () => {
      const a = acc();
      const result = reduceEvent(a, {
        type: "tool_execution_start",
        toolName: "execute_bash",
        toolCallId: "tc-1",
        arguments: { command: "ls" },
      });

      expect(a.activeTools.get("tc-1")?.toolName).toBe("execute_bash");
      expect(result.activity!.phase).toBe("tool-execution");
      if (result.activity!.phase === "tool-execution") {
        expect(result.activity!.tools).toHaveLength(1);
        expect(result.activity!.tools[0]!.toolName).toBe("execute_bash");
      }
      expect(result.outputs.length).toBe(1);
      expect(result.outputs[0]!.type).toBe("info");
      expect(outputText(result.outputs[0])).toContain("execute_bash");
      expect(contentFromOutput(result.outputs[0]!)).toMatchObject({
        kind: "notice",
        audience: "classic",
      });
    });

    test("command_risk_classifying appears as a live tool, not a fake receipt", () => {
      const a = acc();
      const result = reduceEvent(a, {
        type: "command_risk_classifying",
        toolCallId: "tc-1",
        toolName: "execute_command",
        command: "python3 --version",
      });

      expect(result.activity!.phase).toBe("tool-execution");
      if (result.activity!.phase !== "tool-execution") return;
      expect(result.activity!.tools[0]?.classifying).toBe(true);
      expect(result.activity!.tools[0]?.argsPreview).toContain("python3 --version");
      expect(result.outputs).toHaveLength(0);
    });

    test("command_risk_classified keeps an auto-approved call live with the verdict", () => {
      const a = acc();
      a.activeTools.set("tc-1", {
        toolName: "execute_command",
        startedAt: Date.now(),
        argsPreview: 'command: "python3 --version"',
        classifying: true,
      });

      const result = reduceEvent(a, {
        type: "command_risk_classified",
        toolCallId: "tc-1",
        toolName: "execute_command",
        command: "python3 --version",
        riskLevel: "read-only",
        autoApproved: true,
      });

      expect(a.activeTools.get("tc-1")?.classifiedRisk).toBe("read-only");
      expect(a.activeTools.get("tc-1")?.classifying).toBeUndefined();
      expect(result.activity!.phase).toBe("tool-execution");
      if (result.activity!.phase !== "tool-execution") return;
      expect(result.activity!.tools[0]?.classifiedRisk).toBe("read-only");
      expect(result.activity!.tools[0]?.classifying).toBeUndefined();
    });

    test("command_risk_classified hides a prompted call from the live zone", () => {
      const a = acc();
      a.activeTools.set("tc-1", {
        toolName: "execute_command",
        startedAt: Date.now(),
        classifying: true,
      });

      const result = reduceEvent(a, {
        type: "command_risk_classified",
        toolCallId: "tc-1",
        toolName: "execute_command",
        command: "rm -rf /tmp/x",
        riskLevel: "high-risk",
        autoApproved: false,
      });

      expect(a.activeTools.get("tc-1")?.classifiedRisk).toBe("high-risk");
      expect(result.activity!.phase).toBe("idle");
    });

    test("a declined call becomes one denied receipt that names the tool", () => {
      const a = acc();
      reduceEvent(a, {
        type: "approval_resolved",
        toolCallId: "tc-9",
        toolName: "write_file",
        approved: false,
        auto: false,
      });
      const result = reduceEvent(a, {
        type: "tool_execution_complete",
        toolCallId: "tc-9",
        result: JSON.stringify({ rejected: true, message: "put it in my home folder" }),
        durationMs: 0,
        success: false,
        error: "User rejected the operation",
      });
      const toolFacts = receipt(result.outputs[0]) as
        { app?: string; status?: string; reason?: string } | undefined;
      expect(toolFacts?.app).toBe("write_file");
      expect(toolFacts?.status).toBe("denied");
      expect(toolFacts?.reason).toBeUndefined();
    });

    test("a failed call's receipt and its text both say what did not happen and the fix", () => {
      const a = acc();
      a.activeTools.set("tc-slack", { toolName: "mcp_slack_post_message", startedAt: Date.now() });
      const result = reduceEvent(a, {
        type: "tool_execution_complete",
        toolCallId: "tc-slack",
        result: "",
        durationMs: 0,
        success: false,
        error: "401 token expired",
      });
      const toolFacts = receipt(result.outputs[0]) as
        { notDone?: string; remedyKey?: string } | undefined;
      expect(toolFacts?.notDone).toBe("nothing was sent");
      expect(toolFacts?.remedyKey).toBe("/mcp reconnect slack");
      expect(outputText(result.outputs[0])).toContain("nothing was sent");
      expect(outputText(result.outputs[0])).toContain("/mcp reconnect slack");
    });

    test("tool_execution_complete receipt carries the classifier verdict", () => {
      const a = acc();
      a.activeTools.set("tc-1", {
        toolName: "execute_command",
        startedAt: Date.now(),
        argsPreview: 'command: "python3 --version"',
        classifiedRisk: "read-only",
      });

      const result = reduceEvent(a, {
        type: "tool_execution_complete",
        toolCallId: "tc-1",
        result: JSON.stringify({ stdout: "Python 3.14.5", exitCode: 0 }),
        durationMs: 12,
        success: true,
        classifiedRisk: "read-only",
      });

      const toolFacts = receipt(result.outputs[0]) as {
        classifiedRisk?: string;
        summary?: string;
      };
      expect(toolFacts?.classifiedRisk).toBe("read-only");
      expect(toolFacts?.summary).toBe("1 line");
    });

    test("tool_execution_start for view_memory shows root when path is empty", () => {
      const a = acc();
      const result = reduceEvent(a, {
        type: "tool_execution_start",
        toolName: "view_memory",
        toolCallId: "mem-1",
        arguments: { path: "" },
      });

      expect(a.activeTools.get("mem-1")?.argsPreview).toBe("/");
      expect(outputText(result.outputs[0])).toContain("path:");
      expect(outputText(result.outputs[0])).toContain("/");
      if (result.activity?.phase === "tool-execution") {
        expect(result.activity.tools[0]?.argsPreview).toBe("/");
      }
    });

    test("tool_execution_start for web_search appends provider from metadata", () => {
      const a = acc();
      const result = reduceEvent(a, {
        type: "tool_execution_start",
        toolName: "web_search",
        toolCallId: "ws-1",
        arguments: { query: "effect typescript" },
        metadata: { provider: "builtin" },
      });

      expect(result.outputs).toHaveLength(1);
      const line = outputText(result.outputs[0]);
      expect(line).toContain("effect typescript");
      // Provider is folded into the tool name so it can't be mistaken for an
      // argument or a concurrency marker.
      expect(line).toContain("web_search(builtin)");
    });

    test("tool_execution_complete removes tool and transitions to idle when last", () => {
      const a = acc();
      a.activeTools.set("tc-1", { toolName: "execute_bash", startedAt: Date.now() });

      const result = reduceEvent(a, {
        type: "tool_execution_complete",
        toolCallId: "tc-1",
        result: "ok",
        durationMs: 42,
      });

      expect(a.activeTools.size).toBe(0);
      expect(result.activity!.phase).toBe("idle");
      expect(result.outputs.length).toBeGreaterThan(0);
      expect(result.outputs[0]!.type).toBe("log");
    });

    test("tool_execution_complete receipt carries args and an outcome, never the output itself", () => {
      const a = acc();
      a.activeTools.set("mem-1", {
        toolName: "view_memory",
        startedAt: Date.now(),
        argsPreview: "path: /",
      });

      const result = reduceEvent(a, {
        type: "tool_execution_complete",
        toolCallId: "mem-1",
        result: JSON.stringify({
          formatted: "Here're the files and directories up to 2 levels deep in /:\n/notes.txt",
          outcome: {
            kind: "directory",
            path: "/",
            entries: [{ kind: "file", name: "notes.txt" }],
          },
        }),
        durationMs: 12,
        success: true,
      });

      const toolFacts = receipt(result.outputs[0]) as
        { app?: string; args?: string; summary?: string } | undefined;
      expect(toolFacts?.app).toBe("view_memory");
      expect(toolFacts?.args).toBe("path: /");
      expect(toolFacts?.summary).toBe("1 entry");
    });

    test("tool_execution_complete keeps tool-execution phase when other tools remain", () => {
      const a = acc();
      a.activeTools.set("tc-1", { toolName: "bash", startedAt: Date.now() });
      a.activeTools.set("tc-2", { toolName: "read", startedAt: Date.now() });

      const result = reduceEvent(a, {
        type: "tool_execution_complete",
        toolCallId: "tc-1",
        result: "ok",
        durationMs: 10,
      });

      expect(a.activeTools.size).toBe(1);
      expect(result.activity!.phase).toBe("tool-execution");
    });

    test("a loaded skill settles as a one-line receipt with the body behind the expand key", () => {
      const a = acc();
      a.activeTools.set("tc-skill", { toolName: "load_skill", startedAt: Date.now() });
      const skillBody = "Loaded skill: create-rule\n\n# Instructions\n…";
      const result = reduceEvent(a, {
        type: "tool_execution_complete",
        toolCallId: "tc-skill",
        result: JSON.stringify(skillBody),
        durationMs: 2,
      });
      expect(result.outputs).toHaveLength(1);
      expect(result.outputs[0]!.type).toBe("log");
      expect(outputText(result.outputs[0])).not.toContain("\n");
      expect(outputText(result.outputs[0])).toStartWith("load_skill");
    });

    test("tool_execution_complete failure puts the full error on the receipt, not a cropped duplicate", () => {
      const a = acc();
      a.activeTools.set("tc-deny", {
        toolName: "execute_command",
        startedAt: Date.now(),
        argsPreview: `command: "python3 -c \\"import reportlab\\""`,
      });
      const error =
        "Command blocked by the built-in safety denylist: running inline code via an interpreter flag (-c/-e) is on the blocked list; write the code to a temp file and run that instead.";

      const result = reduceEvent(a, {
        type: "tool_execution_complete",
        toolCallId: "tc-deny",
        result: "null",
        durationMs: 4,
        success: false,
        error,
      });

      const toolFacts = receipt(result.outputs[0]) as
        { app?: string; summary?: string; reason?: string } | undefined;
      expect(toolFacts?.app).toBe("execute_command");
      expect(toolFacts?.reason).toBe(error);
      expect(toolFacts?.summary).toBe("");
      expect(toolFacts?.reason).toContain("write the code to a temp file");
    });

    test("tool_execution_complete failure states the error, not the null result", () => {
      const a = acc();
      a.activeTools.set("tc-fail", { toolName: "web_search", startedAt: Date.now() });

      const result = reduceEvent(a, {
        type: "tool_execution_complete",
        toolCallId: "tc-fail",
        result: "null",
        durationMs: 11783,
        success: false,
        error: "exa search failed: invalid API key",
      });

      const text = outputText(result.outputs[0]);
      expect(result.outputs[0]!.type).toBe("log");
      expect(text).toContain("web_search");
      expect(text).toContain("exa search failed: invalid API key");
      expect(text).not.toContain("null");
      const toolFacts = receipt(result.outputs[0]) as { status?: string } | undefined;
      expect(toolFacts?.status).toBe("failed");
    });

    test("tool_execution_complete failure without an error message falls back to a generic reason", () => {
      const a = acc();
      a.activeTools.set("tc-fail-2", { toolName: "web_fetch", startedAt: Date.now() });

      const result = reduceEvent(a, {
        type: "tool_execution_complete",
        toolCallId: "tc-fail-2",
        result: "null",
        durationMs: 72,
        success: false,
      });

      const text = outputText(result.outputs[0]);
      expect(text).toContain("Tool execution failed");
      expect(text).not.toContain("null");
    });

    test("a multi-line result stays behind the expand key instead of filling the scrollback", () => {
      const a = acc();
      a.activeTools.set("tc-1", { toolName: "diff_tool", startedAt: Date.now() });

      const result = reduceEvent(a, {
        type: "tool_execution_complete",
        toolCallId: "tc-1",
        result: "ok",
        durationMs: 10,
        summary: "line1\nline2",
      });

      expect(result.outputs).toHaveLength(1);
      expect(outputText(result.outputs[0])).not.toContain("line2");
    });

    test("manage_todos tool execution exposes todo snapshot in activity", () => {
      const a = acc();
      const result = reduceEvent(a, {
        type: "tool_execution_start",
        toolName: "manage_todos",
        toolCallId: "todo-1",
        arguments: {
          todos: [
            { content: "Check status", status: "completed", priority: "high" },
            { content: "Push branch", status: "in_progress", priority: "medium" },
          ],
        },
      });

      expect(result.activity).not.toBeNull();
      const activity = result.activity;
      expect(activity?.phase).toBe("tool-execution");
      if (activity?.phase === "tool-execution") {
        expect(activity.todoSnapshot).toHaveLength(2);
        expect(activity.todoSnapshot?.[0]?.status).toBe("completed");
      }
    });

    test("manage_todos completion keeps the checklist as the receipt's detail", () => {
      const a = acc();
      a.activeTools.set("todo-1", {
        toolName: "manage_todos",
        startedAt: Date.now(),
        todoSnapshot: [
          { content: "Check status", status: "completed" },
          { content: "Push branch", status: "in_progress" },
        ],
      });

      const result = reduceEvent(a, {
        type: "tool_execution_complete",
        toolCallId: "todo-1",
        result: JSON.stringify({ ok: true }),
        durationMs: 10,
      });

      expect(result.outputs).toHaveLength(1);
      const glyphs = getGlyphs();
      const toolFacts = receipt(result.outputs[0]) as { detail?: string } | undefined;
      expect(toolFacts?.detail).toContain(`${glyphs.success} Check status`);
      expect(toolFacts?.detail).toContain(`${glyphs.proposed} Push branch`);
    });
  });

  // -------------------------------------------------------------------------
  // tools_detected
  // -------------------------------------------------------------------------

  describe("tools_detected", () => {
    test("emits info log with tool names", () => {
      const a = acc();
      const result = reduceEvent(a, {
        type: "tools_detected",
        toolNames: ["bash", "read"],
        toolsRequiringApproval: ["bash"],
        agentName: "TestAgent",
      });

      expect(result.activity).toBeNull();
      expect(result.outputs).toHaveLength(2);
      expect(result.outputs[0]!.type).toBe("log");
      expect(result.outputs[0]!.message).toBe("");
      expect(result.outputs[1]!.type).toBe("info");
    });
  });

  // -------------------------------------------------------------------------
  // error
  // -------------------------------------------------------------------------

  describe("error", () => {
    test("transitions to error phase and emits error log", () => {
      const a = acc();
      const error = new LLMRequestError({ provider: "openai", message: "rate limited" });
      const result = reduceEvent(a, { type: "error", error, recoverable: false });

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
      const result = reduceEvent(a, {
        type: "complete",
        response: completeResponse(""),
        totalDurationMs: 100,
      });

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
      const result = reduceEvent(a, {
        type: "usage_update",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      });

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

      // stream_start → awaiting phase (visible while we wait for first event)
      const r1 = reduceEvent(a, { type: "stream_start", provider: "p", model: "m", timestamp: 0 });
      expect(r1.activity!.phase).toBe("awaiting");

      // thinking_start → thinking phase
      const r2 = reduceEvent(a, { type: "thinking_start", provider: "p" });
      expect(r2.activity!.phase).toBe("thinking");

      // thinking_chunk
      reduceEvent(a, { type: "thinking_chunk", content: "hmm", sequence: 0 });

      // thinking_complete
      reduceEvent(a, { type: "thinking_complete" });

      // text_start — now enters streaming immediately (even before first chunk)
      const r5 = reduceEvent(a, { type: "text_start" });
      expect(r5.activity!.phase).toBe("streaming");
      // text_chunk → streaming (response text is not shown in activity)
      const r6 = reduceEvent(a, {
        type: "text_chunk",
        delta: "Hi",
        accumulated: "Hi",
        sequence: 0,
      });
      expect(r6.activity!.phase).toBe("streaming");
      if (r6.activity!.phase === "streaming") {
        expect(r6.activity!.text).toBe("");
      }

      // complete
      const r7 = reduceEvent(a, {
        type: "complete",
        response: completeResponse("Hi"),
        totalDurationMs: 50,
      });
      expect(r7.activity!.phase).toBe("complete");
    });
  });

  // -------------------------------------------------------------------------
  describe("text container layout (flexDirection column)", () => {
    test("long text does not appear in activity state during streaming", () => {
      const a = acc();
      reduceEvent(a, { type: "text_start" });

      // Even very long text should NOT appear in activity state
      const longText = "A".repeat(5000) + "\n\n" + "B".repeat(100);
      const r2 = reduceEvent(a, {
        type: "text_chunk",
        delta: longText,
        accumulated: longText,
        sequence: 0,
      });

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

    test("short streaming text does not appear in activity.text", () => {
      const a = acc();
      reduceEvent(a, { type: "text_start" });
      const result = reduceEvent(a, {
        type: "text_chunk",
        delta: "Hello world",
        accumulated: "Hello world",
        sequence: 0,
      });

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
      reduceEvent(a, { type: "text_start" });
      const result = reduceEvent(a, {
        type: "text_chunk",
        delta: "Hello",
        accumulated: "Hello",
        sequence: 0,
      });

      expect(result.outputs).toHaveLength(0);
    });

    test("text_chunk produces zero output entries (long text)", () => {
      const a = acc();
      reduceEvent(a, { type: "text_start" });
      const longText = "word ".repeat(1000).trim();
      const result = reduceEvent(a, {
        type: "text_chunk",
        delta: longText,
        accumulated: longText,
        sequence: 0,
      });

      expect(result.outputs).toHaveLength(0);
    });

    test("many sequential text_chunks all produce zero output entries", () => {
      const a = acc();
      reduceEvent(a, { type: "text_start" });

      // Simulate 50 tokens arriving one at a time (real streaming)
      let accumulated = "";
      for (let i = 0; i < 50; i++) {
        const token = `token${i} `;
        accumulated += token;
        const result = reduceEvent(a, {
          type: "text_chunk",
          delta: token,
          accumulated,
          sequence: i,
        });

        // EVERY text_chunk must produce zero outputs
        expect(result.outputs).toHaveLength(0);
        // And must always return a streaming activity with text
        expect(result.activity).not.toBeNull();
        expect(result.activity!.phase).toBe("streaming");
      }

      // Final sequence should be 49 (last chunk)
      expect(a.lastAppliedTextSequence).toBe(49);
    });

    test("text_chunk never produces streamContent output entries regardless of text size", () => {
      const a = acc();
      reduceEvent(a, { type: "text_start" });

      // Try various sizes that might previously have triggered flush thresholds
      const sizes = [100, 500, 2000, 4000, 5000, 10000, 50000];
      for (const size of sizes) {
        const text = "x".repeat(size);
        const result = reduceEvent(a, {
          type: "text_chunk",
          delta: text,
          accumulated: text,
          sequence: size,
        });

        const streamContentEntries = result.outputs.filter((e) => e.type === "streamContent");
        expect(streamContentEntries).toHaveLength(0);
      }
    });
  });

  describe("reducer does not format streaming text", () => {
    test("activity.text remains empty for streaming text", () => {
      const a = acc();
      reduceEvent(a, { type: "text_start" });

      const result = reduceEvent(a, {
        type: "text_chunk",
        delta: "hello world",
        accumulated: "hello world",
        sequence: 0,
      });

      expect(result.activity!.phase).toBe("streaming");
      if (result.activity!.phase === "streaming") {
        expect(result.activity!.text).toBe("");
      }
    });
  });
});
