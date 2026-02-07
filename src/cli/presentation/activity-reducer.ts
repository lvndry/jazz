/**
 * Pure activity reducer — maps StreamEvents to ActivityState + log side-effects.
 *
 * All mutable state lives in the ReducerAccumulator. The reducer is a pure
 * function (given the same accumulator snapshot + event, it produces the same
 * output). Side-effects (printing logs) are returned as LogEntry descriptors
 * so the caller can flush them through the store.
 */

import chalk from "chalk";
import { Box, Text } from "ink";
import React from "react";
import type { TerminalOutput } from "@/core/interfaces/terminal";
import type { StreamEvent } from "@/core/types/streaming";
import { CLIRenderer } from "./cli-renderer";
import { applyTextChunkOrdered } from "./stream-text-order";
import type { ActiveTool, ActivityState } from "../ui/activity-state";
import type { LogEntryInput } from "../ui/types";

function renderToolBadge(label: string): React.ReactElement {
  return React.createElement(
    Box,
    { borderStyle: "round", borderColor: "cyan", paddingX: 1 },
    React.createElement(Text, { color: "cyan" }, label),
  );
}

// ---------------------------------------------------------------------------
// Accumulator — mutable internal state carried between events
// ---------------------------------------------------------------------------

export interface ReducerAccumulator {
  agentName: string;
  liveText: string;
  reasoningBuffer: string;
  completedReasoning: string;
  isThinking: boolean;
  lastAgentHeaderWritten: boolean;
  lastAppliedTextSequence: number;
  activeTools: Map<string, string>;
  /** Provider id captured from stream_start for cost calculation */
  currentProvider: string | null;
  /** Model id captured from stream_start for cost calculation */
  currentModel: string | null;
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
  };
}

// ---------------------------------------------------------------------------
// Reducer result
// ---------------------------------------------------------------------------

export interface ReducerResult {
  /** New activity state to push to the UI (null = no change). */
  activity: ActivityState | null;
  /** Log entries to print immediately. */
  logs: LogEntryInput[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_REASONING_LENGTH = 8000;
const MAX_LIVE_TEXT_LENGTH = 200_000;

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

  if (acc.liveText.length > 0) {
    return {
      phase: "streaming",
      agentName: acc.agentName,
      reasoning: formattedReasoning,
      text: formatMarkdown(acc.liveText),
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
    ([toolCallId, toolName]) => ({
      toolCallId,
      toolName,
      startedAt: Date.now(),
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
  const logs: LogEntryInput[] = [];

  switch (event.type) {
    // ---- Stream lifecycle ------------------------------------------------

    case "stream_start": {
      acc.lastAgentHeaderWritten = true;
      acc.currentProvider = event.provider;
      acc.currentModel = event.model;
      acc.reasoningBuffer = "";
      acc.completedReasoning = "";

      logs.push({
        type: "info",
        message: `${acc.agentName} (${event.provider}/${event.model})`,
        timestamp: new Date(),
      });
      logs.push({
        type: "log",
        message: chalk.dim("(Tip: Press Ctrl+I to stop generation)"),
        timestamp: new Date(),
      });

      return { activity: null, logs };
    }

    // ---- Thinking / Reasoning -------------------------------------------

    case "thinking_start": {
      acc.reasoningBuffer = "";
      acc.isThinking = true;
      return {
        activity: buildThinkingOrStreamingActivity(acc, formatMarkdown),
        logs,
      };
    }

    case "thinking_chunk": {
      acc.reasoningBuffer += event.content;
      return {
        activity: buildThinkingOrStreamingActivity(acc, formatMarkdown),
        logs,
      };
    }

    case "thinking_complete": {
      acc.isThinking = false;

      // Log the reasoning block
      const reasoning = acc.reasoningBuffer.trim();
      if (reasoning.length > 0) {
        const formattedReasoning = formatMarkdown(reasoning);
        const displayReasoning = chalk.gray(formattedReasoning);
        logs.push({
          type: "log",
          message: chalk.gray(`▸ Reasoning\n${displayReasoning}`),
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
        logs,
      };
    }

    // ---- Text content ---------------------------------------------------

    case "text_start": {
      // If reasoning was produced, log a separator before the response
      if (acc.completedReasoning.trim().length > 0) {
        logs.push({
          type: "log",
          message: chalk.dim(`${"─".repeat(40)}\n▸ Response`),
          timestamp: new Date(),
        });
      }
      acc.liveText = "";
      acc.lastAppliedTextSequence = -1;
      return {
        activity: buildThinkingOrStreamingActivity(acc, formatMarkdown),
        logs,
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
      // Cap live text to prevent unbounded memory growth during long responses
      acc.liveText = next.liveText.length > MAX_LIVE_TEXT_LENGTH
        ? next.liveText.slice(-MAX_LIVE_TEXT_LENGTH)
        : next.liveText;
      acc.lastAppliedTextSequence = next.lastAppliedSequence;
      return {
        activity: buildThinkingOrStreamingActivity(acc, formatMarkdown),
        logs,
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
      logs.push({
        type: "info",
        message: inkRender(renderToolBadge(`Tools: ${formattedTools}`)),
        timestamp: new Date(),
      });
      return { activity: null, logs };
    }

    case "tool_call": {
      // Provider-native tools (e.g. web_search via OpenAI) never get a
      // tool_execution_start event, so this is the only place to log them.
      // Non-native tools will be logged by tool_execution_start instead.
      if (!event.providerNative) {
        return { activity: null, logs };
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
        providerLabel = chalk.dim(` [${acc.currentProvider}]`);
      }
      const message = argsStr
        ? `▸ Executing tool: ${toolName}${providerLabel}${argsStr}`
        : `▸ Executing tool: ${toolName}${providerLabel}`;
      logs.push({ type: "log", message, timestamp: new Date() });
      return { activity: null, logs };
    }

    case "tool_execution_start": {
      acc.activeTools.set(event.toolCallId, event.toolName);

      const argsStr = CLIRenderer.formatToolArguments(
        event.toolName,
        event.arguments,
      );
      let providerSuffix = "";
      if (event.toolName === "web_search") {
        const provider = event.metadata?.["provider"];
        if (typeof provider === "string") {
          providerSuffix = chalk.dim(` [${provider}]`);
        }
      }
      const message = argsStr
        ? `▸ Executing tool: ${event.toolName}${providerSuffix}${argsStr}`
        : `▸ Executing tool: ${event.toolName}${providerSuffix}`;
      logs.push({ type: "log", message, timestamp: new Date() });

      return { activity: buildToolExecutionActivity(acc), logs };
    }

    case "tool_execution_complete": {
      const toolName = acc.activeTools.get(event.toolCallId);
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
        logs.push({
          type: "success",
          message: `${namePrefix}done (${event.durationMs}ms)`,
          timestamp: new Date(),
        });
        logs.push({ type: "log", message: displayText, timestamp: new Date() });
      } else {
        logs.push({
          type: "success",
          message: `${displayText} (${event.durationMs}ms)`,
          timestamp: new Date(),
        });
      }

      const activity: ActivityState =
        acc.activeTools.size > 0
          ? buildToolExecutionActivity(acc)
          : { phase: "idle" };

      return { activity, logs };
    }

    // ---- Usage updates (no-op) ------------------------------------------

    case "usage_update":
      return { activity: null, logs };

    // ---- Error ----------------------------------------------------------

    case "error": {
      logs.push({
        type: "error",
        message: `Error: ${event.error.message}`,
        timestamp: new Date(),
      });
      return { activity: { phase: "error", message: event.error.message }, logs };
    }

    // ---- Complete -------------------------------------------------------

    case "complete": {
      // Note: completion card rendering + cost calc stay in the renderer
      // because they need async work and Ink/React rendering.
      // The reducer only signals the phase transition.
      return { activity: { phase: "complete" }, logs: [] };
    }
  }
}
