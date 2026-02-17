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
 * During streaming, ALL response text lives in the live area (`activity.text`).
 * The reducer returns the raw accumulated text; the renderer is responsible for
 * formatting (markdown + wrapping) and only does so when actually pushing to
 * the store (~10/sec via throttle), not on every token (~80/sec).
 *
 * On completion, the renderer prints the full response as a single Static
 * output entry and clears the live area.
 */

import chalk from "chalk";
import { Box, Text } from "ink";
import React from "react";
import type { TerminalOutput } from "@/core/interfaces/terminal";
import type { StreamEvent } from "@/core/types/streaming";
import { formatToolArguments, formatToolResult } from "./format-utils";
import { applyTextChunkOrdered } from "./stream-text-order";
import type { ActiveTool, ActivityState } from "../ui/activity-state";
import { THEME } from "../ui/theme";
import type { OutputEntry } from "../ui/types";

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
  activeTools: Map<string, { toolName: string; startedAt: number }>;
  /** Provider id captured from stream_start for cost calculation. */
  currentProvider: string | null;
  /** Model id captured from stream_start for cost calculation. */
  currentModel: string | null;

  // ── Markdown formatting cache ──────────────────────────────────────
  /** Cached reasoning input */
  _cachedReasoningInput: string;
  /** Cached formatted result for reasoning */
  _cachedReasoningOutput: string;

  /**
   * Whether we've already printed the streaming response header ("X is responding…")
   * into Static output for the current response.
   */
  responseHeaderPrinted: boolean;
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

    responseHeaderPrinted: false,
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
// Constants
// ---------------------------------------------------------------------------

/** Cap for accumulated reasoning text before truncation. */
const MAX_REASONING_LENGTH = 8000;
/** Hard cap for total `liveText` length to prevent unbounded memory growth. */
const MAX_LIVE_TEXT_LENGTH = 200_000;

function renderStreamingResponseHeader(agentName: string): React.ReactElement {
  return React.createElement(
    Box,
    { flexDirection: "column", paddingLeft: 2, marginTop: 1 },
    React.createElement(
      Box,
      {},
      React.createElement(Text, { color: THEME.agent }, "…"),
      React.createElement(Text, {}, " "),
      React.createElement(Text, { bold: true, color: THEME.agent }, agentName),
      React.createElement(Text, { dimColor: true }, " is responding…"),
    ),
    React.createElement(Text, { dimColor: true }, "─".repeat(40)),
  );
}

// ---------------------------------------------------------------------------
// Helper: build the current activity from accumulator state
// ---------------------------------------------------------------------------

function buildThinkingOrStreamingActivity(
  acc: ReducerAccumulator,
  formatMarkdown: (text: string) => string,
): ActivityState {
  const reasoningToShow =
    acc.reasoningBuffer.trim().length > 0
      ? acc.reasoningBuffer
      : acc.completedReasoning.trim().length > 0
        ? acc.completedReasoning
        : "";

  // Use cached formatted reasoning to avoid redundant regex work
  let formattedReasoning: string;
  if (reasoningToShow.length === 0) {
    formattedReasoning = "";
  } else if (reasoningToShow === acc._cachedReasoningInput) {
    formattedReasoning = acc._cachedReasoningOutput;
  } else {
    formattedReasoning = formatMarkdown(reasoningToShow);
    acc._cachedReasoningInput = reasoningToShow;
    acc._cachedReasoningOutput = formattedReasoning;
  }

  if (acc.liveText.length > 0) {
    return {
      phase: "streaming",
      agentName: acc.agentName,
      reasoning: formattedReasoning,
      // Raw text — the renderer formats it only when pushing to the store.
      text: acc.liveText,
    };
  }

  return {
    phase: "thinking",
    agentName: acc.agentName,
    reasoning: formattedReasoning,
  };
}

function buildToolExecutionActivity(acc: ReducerAccumulator): ActivityState {
  const tools: ActiveTool[] = Array.from(acc.activeTools.entries()).map(([toolCallId, entry]) => ({
    toolCallId,
    toolName: entry.toolName,
    startedAt: entry.startedAt,
  }));
  return { phase: "tool-execution", agentName: acc.agentName, tools };
}

// ---------------------------------------------------------------------------
// reduceEvent — pure reducer
// ---------------------------------------------------------------------------

export function reduceEvent(
  acc: ReducerAccumulator,
  event: StreamEvent,
  formatMarkdown: (text: string) => string,
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
      outputs.push({
        type: "log",
        message: chalk.dim("(Tip: Press Esc twice to stop generation)"),
        timestamp: new Date(),
      });

      return { activity: null, outputs };
    }

    // ---- Thinking / Reasoning -------------------------------------------

    case "thinking_start": {
      acc.reasoningBuffer = "";
      acc.isThinking = true;
      return {
        activity: buildThinkingOrStreamingActivity(acc, formatMarkdown),
        outputs,
      };
    }

    case "thinking_chunk": {
      acc.reasoningBuffer += event.content;
      return {
        activity: buildThinkingOrStreamingActivity(acc, formatMarkdown),
        outputs,
      };
    }

    case "thinking_complete": {
      acc.isThinking = false;

      // Log the reasoning block as an Ink element with padding
      const reasoning = acc.reasoningBuffer.trim();
      if (reasoning.length > 0) {
        const formattedReasoning = formatMarkdown(reasoning);
        outputs.push({
          type: "log",
          message: inkRender(
            React.createElement(
              Box,
              { flexDirection: "column", paddingLeft: 2, marginTop: 1, marginBottom: 1 },
              React.createElement(Text, { dimColor: true, italic: true }, "▸ Reasoning"),
              React.createElement(
                Box,
                { marginTop: 0, paddingLeft: 1, flexDirection: "column" },
                React.createElement(Text, { dimColor: true, wrap: "truncate" }, formattedReasoning),
              ),
            ),
          ),
          timestamp: new Date(),
        });
      }

      // Accumulate completed reasoning
      const newReasoning = acc.reasoningBuffer.trim();
      if (newReasoning.length > 0) {
        if (acc.completedReasoning.trim().length > 0) {
          acc.completedReasoning += "\n\n---\n\n" + newReasoning;
        } else {
          acc.completedReasoning = newReasoning;
        }
        // Cap reasoning to prevent unbounded growth
        if (acc.completedReasoning.length > MAX_REASONING_LENGTH) {
          const truncatePoint = acc.completedReasoning.length - MAX_REASONING_LENGTH;
          const nextSeparator = acc.completedReasoning.indexOf("---", truncatePoint);
          if (nextSeparator > 0) {
            acc.completedReasoning =
              "...(earlier reasoning truncated)...\n\n" +
              acc.completedReasoning.substring(nextSeparator);
          } else {
            acc.completedReasoning = acc.completedReasoning.substring(truncatePoint);
          }
        }
      }
      acc.reasoningBuffer = "";

      return {
        activity: buildThinkingOrStreamingActivity(acc, formatMarkdown),
        outputs,
      };
    }

    // ---- Text content ---------------------------------------------------

    case "text_start": {
      acc.responseHeaderPrinted = false;

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

      // Print the "is responding…" header into Static once per response.
      if (!acc.responseHeaderPrinted) {
        outputs.push({
          type: "log",
          message: inkRender(renderStreamingResponseHeader(acc.agentName)),
          timestamp: new Date(),
        });
        acc.responseHeaderPrinted = true;
      }

      acc.liveText = "";
      acc.lastAppliedTextSequence = -1;

      return {
        activity: {
          phase: "streaming",
          agentName: acc.agentName,
          reasoning:
            acc.completedReasoning.trim().length > 0 ? formatMarkdown(acc.completedReasoning) : "",
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
      // Cap live text to prevent unbounded memory growth.
      if (next.liveText.length > MAX_LIVE_TEXT_LENGTH) {
        acc.liveText = next.liveText.slice(-MAX_LIVE_TEXT_LENGTH);
      } else {
        acc.liveText = next.liveText;
      }
      acc.lastAppliedTextSequence = next.lastAppliedSequence;

      // All text stays in the live area — no flushing to Static during streaming.
      return {
        activity: buildThinkingOrStreamingActivity(acc, formatMarkdown),
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
      acc.activeTools.set(event.toolCallId, { toolName: event.toolName, startedAt: Date.now() });

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
