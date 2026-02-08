/**
 * Pure activity reducer — maps StreamEvents to ActivityState + output side-effects.
 *
 * All mutable state lives in the ReducerAccumulator. The reducer is a pure
 * function (given the same accumulator snapshot + event, it produces the same
 * output). Side-effects (printing output) are returned as OutputEntry descriptors
 * so the caller can flush them through the store.
 *
 * ## Live-area flush strategy (anti-blink)
 *
 * Ink's terminal rendering has two regions:
 *   - **Static**: content written once via `<Static>`, never re-rendered.
 *   - **Live area**: the non-Static portion, cleared and redrawn every render cycle.
 *
 * During LLM streaming the response text grows continuously. If the entire
 * accumulated response lives in the live area, each throttled re-render clears
 * and redraws hundreds of lines, causing visible terminal flicker/blink.
 *
 * To fix this, once the unflushed tail of `liveText` exceeds
 * `MAX_LIVE_DISPLAY_CHARS` (~20 lines), we find a safe paragraph boundary
 * (`\n\n` outside fenced code blocks) and move everything before it into Static
 * as an output entry. The live area then only contains the recent tail,
 * keeping redraws small and flicker-free regardless of response length.
 *
 * The `flushedTextOffset` field in the accumulator tracks how much of
 * `liveText` has already been promoted to Static. The full `liveText` string
 * is still kept for the `handleComplete` path which needs the complete response.
 */

import chalk from "chalk";
import { Box, Text } from "ink";
import React from "react";
import type { TerminalOutput } from "@/core/interfaces/terminal";
import type { StreamEvent } from "@/core/types/streaming";
import { CLIRenderer } from "./cli-renderer";
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
  /**
   * Full accumulated response text for the current LLM turn. Only the portion
   * after `flushedTextOffset` is shown in the live area — the rest has already
   * been promoted to Ink's Static region.
   */
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
  /**
   * Character offset into `liveText` up to which content has been flushed to
   * Ink's Static region. `liveText.slice(flushedTextOffset)` is the portion
   * still rendered in the live area. Reset to 0 on text_start and completion.
   */
  flushedTextOffset: number;
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
    flushedTextOffset: 0,
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
/**
 * Maximum characters kept in the live area before flushing older paragraphs
 * to Static. ~1500 chars ≈ ~20 terminal lines, small enough to redraw without
 * visible flicker, large enough to show meaningful context while streaming.
 */
const MAX_LIVE_DISPLAY_CHARS = 1500;

/**
 * Find a safe paragraph break (`\n\n`) to flush text up to, avoiding splits
 * inside fenced code blocks. Scans from `startOffset` to
 * `text.length - maxLiveChars` and returns the position just after the last
 * safe `\n\n`. Returns -1 if no safe point is found.
 */
function findSafeFlushPoint(
  text: string,
  startOffset: number,
  maxLiveChars: number,
): number {
  const searchEnd = text.length - maxLiveChars;
  if (searchEnd <= startOffset) return -1;

  let insideCodeBlock = false;
  let lastSafeBreak = -1;

  for (let i = startOffset; i < searchEnd; i++) {
    // Detect fenced code block toggles (``` at start of line)
    if (
      text[i] === '`' &&
      i + 2 < text.length &&
      text[i + 1] === '`' &&
      text[i + 2] === '`' &&
      (i === 0 || text[i - 1] === '\n')
    ) {
      insideCodeBlock = !insideCodeBlock;
    }

    // Look for paragraph breaks (\n\n) outside code blocks
    if (
      !insideCodeBlock &&
      text[i] === '\n' &&
      i + 1 < searchEnd &&
      text[i + 1] === '\n'
    ) {
      // Position after the double newline
      lastSafeBreak = i + 2;
    }
  }

  return lastSafeBreak;
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
  const formattedReasoning =
    reasoningToShow.length > 0 ? formatMarkdown(reasoningToShow) : "";

  // Only show the unflushed tail in the live area — earlier text is already in Static.
  const displayText = acc.liveText.slice(acc.flushedTextOffset);
  if (displayText.length > 0) {
    return {
      phase: "streaming",
      agentName: acc.agentName,
      reasoning: formattedReasoning,
      text: formatMarkdown(displayText),
    };
  }

  return {
    phase: "thinking",
    agentName: acc.agentName,
    reasoning: formattedReasoning,
  };
}

function buildToolExecutionActivity(acc: ReducerAccumulator): ActivityState {
  const tools: ActiveTool[] = Array.from(acc.activeTools.entries()).map(
    ([toolCallId, entry]) => ({
      toolCallId,
      toolName: entry.toolName,
      startedAt: entry.startedAt,
    }),
  );
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
        message: chalk.dim("(Tip: Press Ctrl+I to stop generation)"),
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
            React.createElement(Box, { flexDirection: "column", paddingLeft: 2, marginTop: 1, marginBottom: 1 },
              React.createElement(Text, { dimColor: true, italic: true }, "▸ Reasoning"),
              React.createElement(Box, { marginTop: 0, paddingLeft: 1 },
                React.createElement(Text, { dimColor: true }, formattedReasoning),
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
          const truncatePoint =
            acc.completedReasoning.length - MAX_REASONING_LENGTH;
          const nextSeparator = acc.completedReasoning.indexOf(
            "---",
            truncatePoint,
          );
          if (nextSeparator > 0) {
            acc.completedReasoning =
              "...(earlier reasoning truncated)...\n\n" +
              acc.completedReasoning.substring(nextSeparator);
          } else {
            acc.completedReasoning =
              acc.completedReasoning.substring(truncatePoint);
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
      // If reasoning was produced, log a separator before the response
      if (acc.completedReasoning.trim().length > 0) {
        outputs.push({
          type: "log",
          message: inkRender(
            React.createElement(Box, { flexDirection: "column", paddingLeft: 2 },
              React.createElement(Text, { dimColor: true }, "─".repeat(40)),
              React.createElement(Text, { dimColor: true, italic: true }, "▸ Response"),
            ),
          ),
          timestamp: new Date(),
        });
      }
      acc.liveText = "";
      acc.flushedTextOffset = 0;
      acc.lastAppliedTextSequence = -1;
      return {
        activity: buildThinkingOrStreamingActivity(acc, formatMarkdown),
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
      // Cap live text to prevent unbounded memory growth during long responses.
      // When trimming, shift flushedTextOffset down by the same amount so it
      // still points at the correct position within the shortened string.
      if (next.liveText.length > MAX_LIVE_TEXT_LENGTH) {
        const trimAmount = next.liveText.length - MAX_LIVE_TEXT_LENGTH;
        acc.liveText = next.liveText.slice(-MAX_LIVE_TEXT_LENGTH);
        acc.flushedTextOffset = Math.max(0, acc.flushedTextOffset - trimAmount);
      } else {
        acc.liveText = next.liveText;
      }
      acc.lastAppliedTextSequence = next.lastAppliedSequence;

      // --- Live-area flush ---
      // When the unflushed tail exceeds the display threshold, find a safe
      // paragraph boundary and promote everything before it to Static output.
      // This keeps the live area small (≤ MAX_LIVE_DISPLAY_CHARS) so Ink
      // redraws don't cause terminal flicker. If no safe split point exists
      // (e.g. one giant code block), we skip the flush and let the live area
      // grow — better to have some flicker than to corrupt markdown formatting.
      if (acc.liveText.length - acc.flushedTextOffset > MAX_LIVE_DISPLAY_CHARS) {
        const flushPoint = findSafeFlushPoint(
          acc.liveText,
          acc.flushedTextOffset,
          MAX_LIVE_DISPLAY_CHARS,
        );
        if (flushPoint > acc.flushedTextOffset) {
          const flushableText = acc.liveText.slice(acc.flushedTextOffset, flushPoint);
          const formatted = formatMarkdown(flushableText);
          outputs.push({
            type: "log",
            message: inkRender(
              React.createElement(Box, { paddingLeft: 2 },
                React.createElement(Text, {}, formatted),
              ),
            ),
            timestamp: new Date(),
          });
          acc.flushedTextOffset = flushPoint;
        }
      }

      return {
        activity: buildThinkingOrStreamingActivity(acc, formatMarkdown),
        outputs,
      };
    }

    // ---- Tool calls -----------------------------------------------------

    case "tools_detected": {
      const approvalSet = new Set(event.toolsRequiringApproval);
      const formattedTools = event.toolNames
        .map((name) =>
          approvalSet.has(name) ? `${name} (requires approval)` : name,
        )
        .join(", ");
      outputs.push({
        type: "info",
        message: inkRender(renderToolBadge(`Tools: ${formattedTools}`)),
        timestamp: new Date(),
      });
      return { activity: null, outputs };
    }

    case "tool_call": {
      // Provider-native tools (e.g. web_search via OpenAI) never get a
      // tool_execution_start event, so this is the only place to log them.
      // Non-native tools will be logged by tool_execution_start instead.
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

      const argsStr = CLIRenderer.formatToolArguments(toolName, parsedArgs);
      let providerLabel = "";
      if (toolName === "web_search" && acc.currentProvider) {
        providerLabel = ` [${acc.currentProvider}]`;
      }
      outputs.push({
        type: "log",
        message: inkRender(
          React.createElement(Box, { paddingLeft: 2, marginTop: 1 },
            React.createElement(Text, { color: THEME.primary }, "▸ "),
            React.createElement(Text, { bold: true }, toolName),
            providerLabel
              ? React.createElement(Text, { dimColor: true }, providerLabel)
              : null,
            argsStr
              ? React.createElement(Text, { dimColor: true }, argsStr)
              : null,
          ),
        ),
        timestamp: new Date(),
      });
      return { activity: null, outputs };
    }

    case "tool_execution_start": {
      acc.activeTools.set(event.toolCallId, { toolName: event.toolName, startedAt: Date.now() });

      const argsStr = CLIRenderer.formatToolArguments(
        event.toolName,
        event.arguments,
      );
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
          React.createElement(Box, { paddingLeft: 2, marginTop: 1 },
            React.createElement(Text, { color: THEME.primary }, "▸ "),
            React.createElement(Text, { bold: true }, event.toolName),
            providerSuffix
              ? React.createElement(Text, { dimColor: true }, providerSuffix)
              : null,
            argsStr
              ? React.createElement(Text, { dimColor: true }, argsStr)
              : null,
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
        summary = CLIRenderer.formatToolResult(toolName, event.result);
      }

      const namePrefix = toolName ? `${toolName} ` : "";
      const displayText =
        summary && summary.length > 0 ? summary : namePrefix + "done";
      const hasMultiLine = displayText.includes("\n");

      if (hasMultiLine) {
        outputs.push({
          type: "log",
          message: inkRender(
            React.createElement(Box, { paddingLeft: 2 },
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
            React.createElement(Box, { paddingLeft: 4 },
              React.createElement(Text, {}, displayText),
            ),
          ),
          timestamp: new Date(),
        });
      } else {
        outputs.push({
          type: "log",
          message: inkRender(
            React.createElement(Box, { paddingLeft: 2 },
              React.createElement(Text, { color: THEME.success }, "✔ "),
              React.createElement(Text, {}, displayText),
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
        acc.activeTools.size > 0
          ? buildToolExecutionActivity(acc)
          : { phase: "idle" };

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
      // Note: completion card rendering + cost calc stay in the renderer
      // because they need async work and Ink/React rendering.
      // The reducer only signals the phase transition.
      return { activity: { phase: "complete" }, outputs: [] };
    }
  }
}
