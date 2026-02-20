/**
 * Pure activity reducer — maps StreamEvents to ActivityState + output side-effects.
 *
 * All mutable state lives in the ReducerAccumulator. The reducer is a pure
 * function (given the same accumulator snapshot + event, it produces the same
 * output). Side-effects (printing output) are returned as OutputEntry descriptors
 * so the caller can flush them through the store.
 *
 * ## Streaming text rendering strategy
 *
 * During streaming, response text is appended directly to output entries so it
 * never disappears from the scrollback. The activity area is reserved for
 * status and reasoning only.
 */

import { Box, Text } from "ink";
import React from "react";
import type { TerminalOutput } from "@/core/interfaces/terminal";
import type { StreamEvent } from "@/core/types/streaming";
import { formatToolArguments, formatToolResult } from "./format-utils";
import { applyTextChunkOrdered } from "./stream-text-order";
import type { ActiveTool, ActivityState } from "../ui/activity-state";
import { THEME } from "../ui/theme";
import type { OutputEntry } from "../ui/types";

interface TodoSnapshotItem {
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

function renderToolBadge(label: string): React.ReactElement {
  return React.createElement(
    Box,
    { borderStyle: "round", borderColor: THEME.primary, paddingX: 1 },
    React.createElement(Text, { color: THEME.primary }, label),
  );
}

// ---------------------------------------------------------------------------
// Accumulator — mutable internal state carried between events
// ---------------------------------------------------------------------------

export interface ReducerAccumulator {
  agentName: string;
  /** Full accumulated response text for the current LLM turn. */
  liveText: string;
  /** In-progress reasoning content (cleared on thinking_complete). */
  reasoningBuffer: string;
  /** All completed reasoning blocks concatenated (for display in live area). */
  completedReasoning: string;
  isThinking: boolean;
  lastAgentHeaderWritten: boolean;
  /** Sequence number for ordering out-of-order text chunks from the stream. */
  lastAppliedTextSequence: number;
  activeTools: Map<
    string,
    { toolName: string; startedAt: number; todoSnapshot?: TodoSnapshotItem[] }
  >;
  /** Provider id captured from stream_start for cost calculation. */
  currentProvider: string | null;
  /** Model id captured from stream_start for cost calculation. */
  currentModel: string | null;

  // ── Markdown formatting cache ──────────────────────────────────────
  /** Cached reasoning input */
  _cachedReasoningInput: string;
  /** Cached formatted result for reasoning */
  _cachedReasoningOutput: string;
}

export function createAccumulator(agentName: string): ReducerAccumulator {
  return {
    agentName,
    liveText: "",
    reasoningBuffer: "",
    completedReasoning: "",
    isThinking: false,
    lastAgentHeaderWritten: false,
    lastAppliedTextSequence: -1,
    activeTools: new Map(),
    currentProvider: null,
    currentModel: null,

    _cachedReasoningInput: "",
    _cachedReasoningOutput: "",
  };
}

// ---------------------------------------------------------------------------
// Reducer result
// ---------------------------------------------------------------------------

export interface ReducerResult {
  /** New activity state to push to the UI (null = no change). */
  activity: ActivityState | null;
  /** Output entries to print immediately. */
  outputs: OutputEntry[];
}

// ---------------------------------------------------------------------------
// Helper: build the current activity from accumulator state
// ---------------------------------------------------------------------------

function buildThinkingOrStreamingActivity(acc: ReducerAccumulator): ActivityState {
  if (acc.liveText.length > 0) {
    return {
      phase: "streaming",
      agentName: acc.agentName,
      reasoning: "",
      // Streaming text is appended to output entries (not shown in activity).
      text: "",
    };
  }

  return {
    phase: "thinking",
    agentName: acc.agentName,
    reasoning: "",
  };
}

function buildToolExecutionActivity(acc: ReducerAccumulator): ActivityState {
  const tools: ActiveTool[] = Array.from(acc.activeTools.entries()).map(([toolCallId, entry]) =>
    entry.todoSnapshot
      ? {
          toolCallId,
          toolName: entry.toolName,
          startedAt: entry.startedAt,
          todoSnapshot: entry.todoSnapshot,
        }
      : {
          toolCallId,
          toolName: entry.toolName,
          startedAt: entry.startedAt,
        },
  );
  const todoSnapshot = findLatestTodoSnapshot(acc.activeTools);
  return todoSnapshot
    ? { phase: "tool-execution", agentName: acc.agentName, tools, todoSnapshot }
    : { phase: "tool-execution", agentName: acc.agentName, tools };
}

function parseTodoSnapshot(args?: Record<string, unknown>): TodoSnapshotItem[] | undefined {
  if (!args) return undefined;
  const rawTodos = args["todos"];
  if (!Array.isArray(rawTodos)) return undefined;

  const todos: TodoSnapshotItem[] = [];
  for (const item of rawTodos) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const content = entry["content"];
    const status = entry["status"];
    if (typeof content !== "string" || typeof status !== "string") continue;
    if (
      status !== "pending" &&
      status !== "in_progress" &&
      status !== "completed" &&
      status !== "cancelled"
    ) {
      continue;
    }
    todos.push({ content, status });
  }
  return todos.length > 0 ? todos : undefined;
}

function findLatestTodoSnapshot(
  activeTools: Map<
    string,
    { toolName: string; startedAt: number; todoSnapshot?: TodoSnapshotItem[] }
  >,
): TodoSnapshotItem[] | undefined {
  let latest: { startedAt: number; todoSnapshot?: TodoSnapshotItem[] } | undefined;
  for (const entry of activeTools.values()) {
    if (entry.toolName !== "manage_todos" || !entry.todoSnapshot) continue;
    if (!latest || entry.startedAt >= latest.startedAt) {
      latest = entry;
    }
  }
  return latest?.todoSnapshot;
}

function formatTodoSnapshotForOutput(todoSnapshot: TodoSnapshotItem[]): string {
  const lines = todoSnapshot.map((todo) => {
    switch (todo.status) {
      case "completed":
        return `✓ ${todo.content}`;
      case "in_progress":
        return `◐ ${todo.content}`;
      case "cancelled":
        return `✗ ${todo.content}`;
      case "pending":
      default:
        return `○ ${todo.content}`;
    }
  });
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// reduceEvent — pure reducer
// ---------------------------------------------------------------------------

export function reduceEvent(
  acc: ReducerAccumulator,
  event: StreamEvent,
  _formatMarkdown: (text: string) => string,
  inkRender: (node: unknown) => TerminalOutput,
): ReducerResult {
  const outputs: OutputEntry[] = [];

  switch (event.type) {
    // ---- Stream lifecycle ------------------------------------------------

    case "stream_start": {
      acc.lastAgentHeaderWritten = true;
      acc.currentProvider = event.provider;
      acc.currentModel = event.model;
      acc.reasoningBuffer = "";
      acc.completedReasoning = "";

      outputs.push({
        type: "info",
        message: `${acc.agentName} (${event.provider}/${event.model})`,
        timestamp: new Date(),
      });

      return { activity: null, outputs };
    }

    // ---- Thinking / Reasoning -------------------------------------------

    case "thinking_start": {
      acc.reasoningBuffer = "";
      acc.isThinking = true;
      return {
        activity: buildThinkingOrStreamingActivity(acc),
        outputs,
      };
    }

    case "thinking_chunk": {
      acc.reasoningBuffer += event.content;
      return {
        activity: buildThinkingOrStreamingActivity(acc),
        outputs,
      };
    }

    case "thinking_complete": {
      acc.isThinking = false;

      // Accumulate completed reasoning (used by text_start to decide separator)
      const newReasoning = acc.reasoningBuffer.trim();
      if (newReasoning.length > 0) {
        if (acc.completedReasoning.trim().length > 0) {
          acc.completedReasoning += "\n\n---\n\n" + newReasoning;
        } else {
          acc.completedReasoning = newReasoning;
        }
      }
      acc.reasoningBuffer = "";

      return {
        activity: buildThinkingOrStreamingActivity(acc),
        outputs,
      };
    }

    // ---- Text content ---------------------------------------------------

    case "text_start": {
      // If reasoning was produced, log a separator before the response
      if (acc.completedReasoning.trim().length > 0) {
        outputs.push({
          type: "log",
          message: inkRender(
            React.createElement(
              Box,
              { flexDirection: "column", paddingLeft: 2 },
              React.createElement(Text, { dimColor: true }, "─".repeat(40)),
              React.createElement(Text, { dimColor: true, italic: true }, "▸ Response"),
            ),
          ),
          timestamp: new Date(),
        });
      }

      acc.liveText = "";
      acc.lastAppliedTextSequence = -1;

      return {
        activity: {
          phase: "streaming",
          agentName: acc.agentName,
          // Completed reasoning was already logged to Static output, so don't
          // duplicate it in the live area.
          reasoning: "",
          text: "",
        },
        outputs,
      };
    }

    case "text_chunk": {
      const next = applyTextChunkOrdered(
        {
          liveText: acc.liveText,
          lastAppliedSequence: acc.lastAppliedTextSequence,
        },
        { sequence: event.sequence, accumulated: event.accumulated },
      );
      acc.liveText = next.liveText;
      acc.lastAppliedTextSequence = next.lastAppliedSequence;

      // All text stays in the live area — no flushing to Static during streaming.
      return {
        activity: buildThinkingOrStreamingActivity(acc),
        outputs,
      };
    }

    // ---- Tool calls -----------------------------------------------------

    case "tools_detected": {
      const approvalSet = new Set(event.toolsRequiringApproval);
      const formattedTools = event.toolNames
        .map((name) => (approvalSet.has(name) ? `${name} (requires approval)` : name))
        .join(", ");
      outputs.push({
        type: "info",
        message: inkRender(renderToolBadge(`Tools: ${formattedTools}`)),
        timestamp: new Date(),
      });
      return { activity: null, outputs };
    }

    case "tool_call": {
      if (!event.providerNative) {
        return { activity: null, outputs };
      }

      const toolName = event.toolCall.function.name;
      let parsedArgs: Record<string, unknown> | undefined;
      try {
        const raw: unknown = JSON.parse(event.toolCall.function.arguments);
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          parsedArgs = raw as Record<string, unknown>;
        }
      } catch {
        // ignore parse errors
      }

      const argsStr = formatToolArguments(toolName, parsedArgs);
      let providerLabel = "";
      if (toolName === "web_search" && acc.currentProvider) {
        providerLabel = ` [${acc.currentProvider}]`;
      }
      outputs.push({
        type: "log",
        message: inkRender(
          React.createElement(
            Box,
            { paddingLeft: 2, marginTop: 1 },
            React.createElement(Text, { color: THEME.primary }, "▸ "),
            React.createElement(Text, { bold: true }, toolName),
            providerLabel ? React.createElement(Text, { dimColor: true }, providerLabel) : null,
            argsStr ? React.createElement(Text, { dimColor: true }, argsStr) : null,
          ),
        ),
        timestamp: new Date(),
      });
      return { activity: null, outputs };
    }

    case "tool_execution_start": {
      const todoSnapshot =
        event.toolName === "manage_todos" ? parseTodoSnapshot(event.arguments) : undefined;
      if (todoSnapshot) {
        acc.activeTools.set(event.toolCallId, {
          toolName: event.toolName,
          startedAt: Date.now(),
          todoSnapshot,
        });
      } else {
        acc.activeTools.set(event.toolCallId, {
          toolName: event.toolName,
          startedAt: Date.now(),
        });
      }

      const argsStr = formatToolArguments(event.toolName, event.arguments);
      let providerSuffix = "";
      if (event.toolName === "web_search") {
        const provider = event.metadata?.["provider"];
        if (typeof provider === "string") {
          providerSuffix = ` [${provider}]`;
        }
      }
      outputs.push({
        type: "log",
        message: inkRender(
          React.createElement(
            Box,
            { paddingLeft: 2, marginTop: 1 },
            React.createElement(Text, { color: THEME.primary }, "▸ "),
            React.createElement(Text, { bold: true }, event.toolName),
            providerSuffix ? React.createElement(Text, { dimColor: true }, providerSuffix) : null,
            argsStr ? React.createElement(Text, { dimColor: true }, argsStr) : null,
          ),
        ),
        timestamp: new Date(),
      });

      return { activity: buildToolExecutionActivity(acc), outputs };
    }

    case "tool_execution_complete": {
      const toolEntry = acc.activeTools.get(event.toolCallId);
      const toolName = toolEntry?.toolName;
      acc.activeTools.delete(event.toolCallId);

      let summary = event.summary?.trim();
      if (
        toolName === "manage_todos" &&
        toolEntry?.todoSnapshot &&
        toolEntry.todoSnapshot.length > 0
      ) {
        summary = `Todo list\n${formatTodoSnapshotForOutput(toolEntry.todoSnapshot)}`;
      }
      if (!summary && toolName && event.result) {
        summary = formatToolResult(toolName, event.result);
      }

      const namePrefix = toolName ? `${toolName} ` : "";
      const displayText = summary && summary.length > 0 ? summary : namePrefix + "done";
      const hasMultiLine = displayText.includes("\n");

      if (hasMultiLine) {
        outputs.push({
          type: "log",
          message: inkRender(
            React.createElement(
              Box,
              { paddingLeft: 2 },
              React.createElement(Text, { color: THEME.success }, "✔ "),
              React.createElement(Text, {}, `${namePrefix}done`),
              React.createElement(Text, { dimColor: true }, ` (${event.durationMs}ms)`),
            ),
          ),
          timestamp: new Date(),
        });
        outputs.push({
          type: "log",
          message: inkRender(
            React.createElement(
              Box,
              { paddingLeft: 4, flexDirection: "column" },
              React.createElement(Text, { wrap: "truncate" }, displayText),
            ),
          ),
          timestamp: new Date(),
        });
      } else {
        outputs.push({
          type: "log",
          message: inkRender(
            React.createElement(
              Box,
              { paddingLeft: 2 },
              React.createElement(Text, { color: THEME.success }, "✔ "),
              React.createElement(Text, { wrap: "truncate" }, displayText),
              React.createElement(Text, { dimColor: true }, ` (${event.durationMs}ms)`),
            ),
          ),
          timestamp: new Date(),
        });
      }

      // Add spacing after tool completion
      outputs.push({
        type: "log",
        message: "",
        timestamp: new Date(),
      });

      const activity: ActivityState =
        acc.activeTools.size > 0 ? buildToolExecutionActivity(acc) : { phase: "idle" };

      return { activity, outputs };
    }

    // ---- Usage updates (no-op) ------------------------------------------

    case "usage_update":
      return { activity: null, outputs };

    // ---- Error ----------------------------------------------------------

    case "error": {
      outputs.push({
        type: "error",
        message: `Error: ${event.error.message}`,
        timestamp: new Date(),
      });
      return { activity: { phase: "error", message: event.error.message }, outputs };
    }

    // ---- Complete -------------------------------------------------------

    case "complete": {
      return { activity: { phase: "complete" }, outputs: [] };
    }
  }
}
