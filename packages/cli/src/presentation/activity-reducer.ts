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

import type { TerminalOutput } from "@jazz/core/interfaces/terminal";
import type { StreamEvent } from "@jazz/core/types/streaming";
import { isRecord } from "@jazz/core/utils/is-record";
import { fileMutationDiffPreview, isDiffReceiptTool } from "@jazz/core/utils/tool-formatter";
import { Box, Text } from "ink";
import React from "react";
import {
  compactToolArguments,
  formatToolArguments,
  formatToolDisplayName,
  formatToolResult,
} from "./format-utils";
import type { ActiveTool, ActivityState, TodoSnapshotItem } from "../ui/activity-state";
import { getGlyphs } from "../ui/glyphs";
import { receiptPlainText, toolReceipt } from "../ui/models/receipt";
import { THEME } from "../ui/theme";
import type { OutputEntry } from "../ui/types";

/**
 * Playful gerund-form labels shown while waiting for the model's first stream
 * event. Picked at random on each stream_start so the UX during prompt eval
 * reads as deliberate-and-interesting rather than blank-and-broken.
 *
 * Each label is the full predicate so it composes as
 * "{agentName} {label}…" in ActivityView, e.g. "Cassandra is cooking…".
 */
export const AWAITING_LABELS: readonly string[] = [
  "is tuning up",
  "is counting in",
  "is riffing",
  "is finding the groove",
  "is warming up the horns",
  "is setting the tempo",
  "is taking it from the top",
  "is improvising",
  "is reading the charts",
  "is picking up the rhythm",
  "is working out the changes",
  "is in the woodshed",
];

function pickAwaitingLabel(): string {
  const i = Math.floor(Math.random() * AWAITING_LABELS.length);
  return AWAITING_LABELS[i] ?? "is cooking";
}

function renderToolBadge(label: string): React.ReactElement {
  return React.createElement(
    Box,
    { borderStyle: "round", borderColor: THEME.toolBorder, paddingX: 1 },
    React.createElement(Text, { color: THEME.agent }, label),
  );
}

// ---------------------------------------------------------------------------
// Accumulator — mutable internal state carried between events
// ---------------------------------------------------------------------------

export interface ReducerAccumulator {
  agentName: string;
  isThinking: boolean;
  lastAgentHeaderWritten: boolean;
  /** Sequence number for ordering out-of-order text chunks from the stream. */
  lastAppliedTextSequence: number;
  activeTools: Map<
    string,
    {
      toolName: string;
      /** Name with backend folded in (e.g. web_search(brave)); falls back to toolName. */
      displayName?: string;
      startedAt: number;
      argsPreview?: string;
      todoSnapshot?: TodoSnapshotItem[];
      classifying?: boolean;
      classifiedRisk?: string;
      /** Hidden from the live zone while the approval card owns this call. */
      awaitingApproval?: boolean;
    }
  >;
  /** Provider id captured from stream_start for cost calculation. */
  currentProvider: string | null;
  /** Model id captured from stream_start for cost calculation. */
  currentModel: string | null;
  /** Running USD cost across the session, summed after each completion. */
  cumulativeCostUSD: number;
  /** Last observed prompt-side token count (used for the footer's tokens-in-context). */
  lastPromptTokens: number;
}

export function createAccumulator(agentName: string): ReducerAccumulator {
  return {
    agentName,
    isThinking: false,
    lastAgentHeaderWritten: false,
    lastAppliedTextSequence: -1,
    activeTools: new Map(),
    currentProvider: null,
    currentModel: null,
    cumulativeCostUSD: 0,
    lastPromptTokens: 0,
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
  if (acc.lastAppliedTextSequence >= 0) {
    return {
      phase: "streaming",
      agentName: acc.agentName,
      text: "",
    };
  }
  return {
    phase: "thinking",
    agentName: acc.agentName,
  };
}

function buildToolExecutionActivity(acc: ReducerAccumulator): ActivityState {
  const tools: ActiveTool[] = Array.from(acc.activeTools.entries())
    .filter(([, entry]) => entry.awaitingApproval !== true)
    .map(([toolCallId, entry]) => ({
      toolCallId,
      toolName: entry.displayName ?? entry.toolName,
      startedAt: entry.startedAt,
      ...(entry.argsPreview !== undefined && entry.argsPreview.length > 0
        ? { argsPreview: entry.argsPreview }
        : {}),
      ...(entry.todoSnapshot ? { todoSnapshot: entry.todoSnapshot } : {}),
      ...(entry.classifying === true ? { classifying: true } : {}),
      ...(entry.classifiedRisk !== undefined ? { classifiedRisk: entry.classifiedRisk } : {}),
    }));
  if (tools.length === 0) {
    return { phase: "idle" };
  }
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
    if (!isRecord(item)) continue;
    const entry = item;
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
    const verifiedBy = entry["verifiedBy"];
    todos.push({
      content,
      status,
      ...(typeof verifiedBy === "string" && verifiedBy.length > 0 ? { verifiedBy } : {}),
    });
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
  const glyphs = getGlyphs();
  const lines = todoSnapshot.map((todo) => {
    switch (todo.status) {
      case "completed":
        return `${glyphs.success} ${todo.content}`;
      case "in_progress":
        return `${glyphs.proposed} ${todo.content}`;
      case "cancelled":
        return `${glyphs.error} ${todo.content}`;
      case "pending":
      default:
        return `${glyphs.pending} ${todo.content}`;
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
  inkRender: (node: unknown) => TerminalOutput,
): ReducerResult {
  const outputs: OutputEntry[] = [];

  switch (event.type) {
    // ---- Stream lifecycle ------------------------------------------------

    case "stream_start": {
      acc.lastAgentHeaderWritten = true;
      acc.currentProvider = event.provider;
      acc.currentModel = event.model;
      acc.lastAppliedTextSequence = -1;
      acc.isThinking = false;

      // Agent turn header: the note glyph is Jazz's signature turn marker.
      outputs.push({
        type: "log",
        message: inkRender(
          React.createElement(
            Box,
            null,
            React.createElement(Text, { color: THEME.agent }, `${getGlyphs().note} `),
            React.createElement(Text, { color: THEME.agent, bold: true }, acc.agentName),
            React.createElement(Text, { dimColor: true }, ` · ${event.provider}/${event.model}`),
          ),
        ),
        timestamp: new Date(),
      });

      // Show an awaiting indicator until the first real event arrives.
      // For local models with long prompt eval (llama.cpp, ollama with
      // big contexts) this gap is otherwise visually silent, which looks
      // like a hang. The next thinking_start/text_start/tool_call replaces
      // this state automatically. The label is picked at random per turn
      // so long waits feel less like a hang and more like a personality.
      return {
        activity: {
          phase: "awaiting",
          agentName: acc.agentName,
          provider: event.provider,
          model: event.model,
          label: pickAwaitingLabel(),
        },
        outputs,
      };
    }

    // ---- Thinking / Reasoning -------------------------------------------

    case "thinking_start": {
      acc.isThinking = true;
      return {
        activity: buildThinkingOrStreamingActivity(acc),
        outputs,
      };
    }

    case "thinking_chunk": {
      return {
        activity: buildThinkingOrStreamingActivity(acc),
        outputs,
      };
    }

    case "thinking_complete": {
      acc.isThinking = false;
      return {
        activity: buildThinkingOrStreamingActivity(acc),
        outputs,
      };
    }

    // ---- Text content ---------------------------------------------------

    case "text_start": {
      acc.lastAppliedTextSequence = -1;

      return {
        activity: {
          phase: "streaming",
          agentName: acc.agentName,
          text: "",
        },
        outputs,
      };
    }

    case "text_chunk": {
      if (event.sequence > acc.lastAppliedTextSequence) {
        acc.lastAppliedTextSequence = event.sequence;
      }
      return {
        activity: buildThinkingOrStreamingActivity(acc),
        outputs,
      };
    }

    // ---- Tool calls -----------------------------------------------------

    case "tools_detected": {
      const approvalSet = new Set(event.toolsRequiringApproval);
      // Dedupe repeated tool names with a count so a batch of 5 execute_command
      // calls reads "execute_command ×5 (requires approval)" instead of five
      // identical, unreadable entries.
      const counts = new Map<string, number>();
      for (const name of event.toolNames) counts.set(name, (counts.get(name) ?? 0) + 1);
      const formattedTools = Array.from(counts.entries())
        .map(([name, count]) => {
          const label = count > 1 ? `${name} ×${count}` : name;
          return approvalSet.has(name) ? `${label} (requires approval)` : label;
        })
        .join(", ");
      // Blank line after prior static output (e.g. metrics/cost from complete) before the badge.
      outputs.push({
        type: "log",
        message: "",
        timestamp: new Date(),
      });
      outputs.push({
        type: "info",
        message: inkRender(renderToolBadge(`Tools: ${formattedTools}`)),
        timestamp: new Date(),
      });
      return { activity: null, outputs };
    }

    case "tool_call": {
      return { activity: null, outputs };
    }

    case "tool_execution_start": {
      const todoSnapshot =
        event.toolName === "manage_todos" ? parseTodoSnapshot(event.arguments) : undefined;
      const args = formatToolArguments(
        event.toolName,
        event.arguments,
        event.metadata !== undefined ? { metadata: event.metadata } : undefined,
      );
      const argsPreview = compactToolArguments(event.toolName, event.arguments);
      const displayName = formatToolDisplayName(event.toolName, event.metadata);
      const prior = acc.activeTools.get(event.toolCallId);
      acc.activeTools.set(event.toolCallId, {
        toolName: event.toolName,
        ...(displayName !== event.toolName ? { displayName } : {}),
        startedAt: Date.now(),
        ...(argsPreview.length > 0 ? { argsPreview } : {}),
        ...(todoSnapshot ? { todoSnapshot } : {}),
        ...(prior?.classifiedRisk !== undefined ? { classifiedRisk: prior.classifiedRisk } : {}),
      });

      outputs.push({
        type: "info",
        message: `${displayName}${args.length > 0 ? ` ${args}` : ""}`,
        timestamp: new Date(),
        meta: { toolStart: true },
      });

      return { activity: buildToolExecutionActivity(acc), outputs };
    }

    case "tool_execution_complete": {
      const toolEntry = acc.activeTools.get(event.toolCallId);
      // A call refused before it started never sent a start event; the completion names it.
      const toolName = toolEntry?.toolName ?? event.toolName;
      acc.activeTools.delete(event.toolCallId);

      const failed = event.success === false;
      const todoSnapshot = toolEntry?.todoSnapshot;
      const formattedResult = failed
        ? undefined
        : toolName === "manage_todos" && todoSnapshot !== undefined && todoSnapshot.length > 0
          ? formatTodoSnapshotForOutput(todoSnapshot)
          : toolName !== undefined && event.result.length > 0
            ? formatToolResult(toolName, event.result)
            : undefined;
      const receipt = toolReceipt({
        toolName,
        argsPreview: toolEntry?.argsPreview,
        success: event.success,
        error: event.error,
        summary: event.summary,
        result: event.result,
        formattedResult,
        diffPreview:
          toolName !== undefined && isDiffReceiptTool(toolName)
            ? fileMutationDiffPreview(event.result)
            : undefined,
        durationMs: event.durationMs,
        classifiedRisk: event.classifiedRisk ?? toolEntry?.classifiedRisk,
      });

      // The entry holds the receipt itself; every renderer lays it out from `meta`, and the
      // message is its words as plain text for search, copy and anything that reads text.
      outputs.push({
        type: "log",
        message: receiptPlainText(receipt, getGlyphs(), { duration: true }),
        timestamp: new Date(),
        meta: { toolReceipt: receipt },
      });

      const activity: ActivityState =
        acc.activeTools.size > 0 ? buildToolExecutionActivity(acc) : { phase: "idle" };

      return { activity, outputs };
    }

    // ---- Usage + approval -----------------------------------------------

    case "command_risk_classifying": {
      acc.activeTools.set(event.toolCallId, {
        toolName: event.toolName,
        startedAt: Date.now(),
        argsPreview: compactToolArguments(event.toolName, { command: event.command }),
        classifying: true,
      });
      return { activity: buildToolExecutionActivity(acc), outputs };
    }

    case "command_risk_classified": {
      const existing = acc.activeTools.get(event.toolCallId);
      acc.activeTools.set(event.toolCallId, {
        toolName: existing?.toolName ?? event.toolName,
        startedAt: existing?.startedAt ?? Date.now(),
        ...(existing?.argsPreview !== undefined ? { argsPreview: existing.argsPreview } : {}),
        classifiedRisk: event.riskLevel,
        ...(event.autoApproved ? {} : { awaitingApproval: true }),
      });
      return { activity: buildToolExecutionActivity(acc), outputs };
    }

    case "approval_resolved": {
      // A declined call never emits a start event, so remember its name here for
      // the denied receipt its completion produces.
      if (!event.approved && !acc.activeTools.has(event.toolCallId)) {
        acc.activeTools.set(event.toolCallId, { toolName: event.toolName, startedAt: Date.now() });
      }
      return { activity: null, outputs };
    }

    case "usage_update":
    case "run_spend":
    case "approval_required":
    case "subagent_start":
    case "subagent_complete":
    case "subagent_result":
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
      return { activity: { phase: "complete" }, outputs };
    }
  }
}
