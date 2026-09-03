/**
 * Ink implementation of PresentationService: `InkStreamingRenderer` turns
 * StreamEvents into activity state + output entries pushed to the Ink store,
 * and `InkPresentationService` wires it up as the primary rendering path when
 * the Ink UI is active. See cli-renderer.ts for the non-Ink fallback path.
 */

import { resolveEffectiveContextWindow } from "@jazz/core/agent/context/effective-context-window";
import { DEFAULT_DISPLAY_CONFIG } from "@jazz/core/agent/types";
import { AgentConfigServiceTag } from "@jazz/core/interfaces/agent-config";
import {
  NotificationServiceTag,
  type NotificationService,
} from "@jazz/core/interfaces/notification";
import type {
  EphemeralRegionCollapse,
  EphemeralRegionKind,
  FilePickerRequest,
  PresentationService,
  StreamingRenderer,
  StreamingRendererConfig,
  StreamTarget,
  UserInputOutcome,
  UserInputRequest,
} from "@jazz/core/interfaces/presentation";
import { PresentationServiceTag } from "@jazz/core/interfaces/presentation";
import { ink } from "@jazz/core/interfaces/terminal";
import { resolveDisplayConfig } from "@jazz/core/presentation/display-config";
import type { DisplayConfig } from "@jazz/core/types/output";
import type { StreamEvent } from "@jazz/core/types/streaming";
import type { ApprovalOutcome, ApprovalRequest } from "@jazz/core/types/tools";
import { getModelsDevMetadata, getModelsDevMetadataSync } from "@jazz/core/utils/models-dev";
import { extractCommandApprovalKey } from "@jazz/core/utils/shell";
import {
  expandableFileMutationPayload,
  expandableToolResultPayload,
  isFileMutationTool,
} from "@jazz/core/utils/tool-formatter";
import { computeUsageCostUSD, type UsageCostPricing } from "@jazz/core/utils/usage-cost";
import chalk from "chalk";
import { Effect, Layer, Option } from "effect";
import { Box, Text } from "ink";
import React from "react";
import type { ActivityState } from "@/cli/ui/activity-state";
import { createAccumulator, reduceEvent } from "./activity-reducer";
import {
  formatToolArguments,
  formatToolDisplayName,
  formatToolExecutionCompleteEffect,
  formatToolExecutionErrorEffect,
  formatToolExecutionStartEffect,
  formatToolResult,
  formatToolsDetectedEffect,
  formatWarning,
} from "./format-utils";
import {
  formatMarkdown,
  formatMarkdownHybrid,
  getTerminalWidth,
  wrapToWidth,
} from "./markdown-formatter";
import { isInsideOpenStructure } from "./markdown-split";
import { AgentResponseCard } from "../ui/AgentResponseCard";
import { getGlyphs } from "../ui/glyphs";
import { store } from "../ui/store";
import { CHALK_THEME, PADDING, THEME } from "../ui/theme";
import { separatorLine } from "../utils/string-utils";

/** Last-N-lines cap for a live sub-agent panel. */
const SUBAGENT_PANEL_LINES = 12;

/**
 * Width offset used when wrapping a user-echo, matching `terminal.ts`.
 * App `paddingX={3}` (6) plus the user-entry rail and space (2).
 */
const USER_ECHO_WIDTH_OFFSET = 8;

function echoUserTurn(text: string): void {
  store.printOutput({
    type: "user",
    message: wrapToWidth(text, getTerminalWidth() - USER_ECHO_WIDTH_OFFSET),
    meta: { plainText: text }, // unwrapped source for non-Ink renderers
    timestamp: new Date(),
  });
}

function formatSubagentCollapseLine(label: string, outcome: EphemeralRegionCollapse): string {
  const glyphs = getGlyphs();
  if (outcome.status === "completed") {
    const seconds = (outcome.durationMs / 1000).toFixed(1);
    const parts = [`${label} completed`, `${seconds}s`];
    if (outcome.totalTokens !== undefined) parts.push(`${compactCount(outcome.totalTokens)} tok`);
    if (outcome.costUSD !== undefined) parts.push(formatOutroCost(outcome.costUSD));
    return chalk.dim(chalk.italic(`${glyphs.success} ${parts.join(" · ")}`));
  }
  const verb = outcome.status === "failed" ? "failed" : "interrupted";
  return chalk.dim(chalk.italic(`${glyphs.error} ${label} ${verb}`));
}

function compactCount(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  return `${Math.round(count / 1000)}k`;
}

function formatOutroCost(cost: number): string {
  if (cost === 0) return "$0.00";
  if (cost >= 0.01) return `$${cost.toFixed(2)}`;
  if (cost >= 0.0001) return `$${cost.toFixed(4)}`;
  return `<$0.0001`;
}

/**
 * Bridges the pure activity reducer with Ink's rendering system.
 *
 * Receives `StreamEvent`s from the agent runtime, runs them through
 * `reduceEvent()` to get UI state + output side-effects, then pushes
 * those into the Ink store.
 *
 * **Throttling**: High-frequency events (text_chunk, thinking_chunk) are
 * throttled to one React re-render per `UPDATE_THROTTLE_MS` to keep CPU
 * usage reasonable. Infrequent events (tool start/complete) bypass the
 * throttle so spinners appear immediately.
 *
 * **Tail-cap**: During streaming, `formatActivityText` formats the full
 * accumulated raw text and returns only the last N lines (where N fits the
 * terminal height) as `activity.text` for the live area. No content is
 * flushed to Static during streaming — the live area stays within the
 * terminal height at all times.
 *
 * **Formatting**: Always uses stateless `formatMarkdown()` — the same code
 * path for both streaming and completion. This eliminates format mismatches
 * that caused truncation bugs with progressive (stateful) formatting.
 *
 * **Completion**: The full authoritative response (`event.response.content`)
 * is printed to Static as a single entry so it becomes fully scrollable.
 */

/**
 * One buffered streaming delta. Either targets the global scrollback pending
 * buffer (via `store.appendStream`) or a specific ephemeral region (via
 * `store.appendEphemeral`). The flush coalesces consecutive entries with
 * the same target.
 */
type BufferedStreamDelta =
  | { readonly target: "stream"; readonly kind: "response" | "reasoning"; readonly delta: string }
  | { readonly target: "ephemeral"; readonly regionId: string; readonly delta: string };

function sameBufferTarget(a: BufferedStreamDelta, b: BufferedStreamDelta): boolean {
  if (a.target !== b.target) return false;
  if (a.target === "stream" && b.target === "stream") return a.kind === b.kind;
  if (a.target === "ephemeral" && b.target === "ephemeral") return a.regionId === b.regionId;
  return false;
}

export class InkStreamingRenderer implements StreamingRenderer {
  private readonly acc;
  /** Timestamp of the last activity state push to the store. */
  private lastUpdateTime: number = 0;
  /** Most recent activity state waiting to be flushed by the throttle timer. */
  private pendingActivity: ActivityState | null = null;
  /** Timer handle for the throttled activity update. */
  private updateTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private readonly updateThrottleMs: number;

  /** Cumulative chars of stream text already pushed into store.appendStream. */
  private seenLength = 0;
  /** True if any text delta was emitted in the current round (for handleComplete fallback). */
  private hasStreamedText = false;

  /**
   * Active reasoning ephemeral region id (null if none open). Reasoning is
   * routed through a bounded live panel separate from scrollback so the
   * user-facing response stream never has to share a buffer with planning text.
   */
  private reasoningRegionId: string | null = null;
  /** Cumulative reasoning text for the active region — used as expand-on-Ctrl-R payload. */
  private reasoningFullText = "";
  /** Wall-clock start of the current reasoning region. */
  private reasoningStartedAt = 0;

  private toolTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private static readonly TOOL_WARNING_MS = 30_000;
  private static readonly MIN_REASONING_PANEL_LINES = 8;
  private static readonly MAX_REASONING_PANEL_LINES = 24;

  /**
   * Reasoning panel height adapts to the terminal: roughly a quarter of the
   * rows, clamped so short terminals still get a useful window and tall ones
   * don't drown the transcript in live planning text.
   */
  private static reasoningPanelLines(): number {
    const rows = process.stdout.rows ?? 24;
    return Math.min(
      InkStreamingRenderer.MAX_REASONING_PANEL_LINES,
      Math.max(InkStreamingRenderer.MIN_REASONING_PANEL_LINES, Math.floor(rows / 4)),
    );
  }

  /**
   * Buffered streaming deltas, flushed at `textBufferMs` cadence. Without
   * buffering, every token (~60–80/sec) triggers a React re-render of the
   * live area; with it the live area updates at the buffer cadence
   * (e.g. ~12 fps at 80ms), giving a "line-by-line" feel similar to
   * claude.ai instead of a frantic chunk-by-chunk one.
   *
   * Stored as a discriminated-union in-order array so deltas keep their
   * arrival order at flush time AND we can route to either the global
   * scrollback `appendStream` (main agent's response) or to a specific
   * ephemeral region's `appendEphemeral` (reasoning panel, sub-agent panel).
   */
  private streamBuffer: BufferedStreamDelta[] = [];
  private streamFlushTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private readonly textBufferMs: number;

  /** Default buffer cadence — visible "live typing" without burning CPU. */
  private static readonly DEFAULT_TEXT_BUFFER_MS = 80;

  /**
   * Cumulative response text seen this turn — used to detect whether the
   * stream is currently "inside" an open markdown structure (code fence,
   * table). When it is, the next live-area flush is deferred so partial
   * tables and code blocks don't render with shifting column widths or
   * recoloring. Reset on text_start / complete / reset / flush.
   */
  private cumulativeResponseText = "";

  /**
   * Wall-clock when adaptive deferral started for the current run of buffered
   * deltas. Capped at MAX_ADAPTIVE_WAIT_MS so a long fenceless code block
   * doesn't make the live area silent for many seconds.
   */
  private adaptiveDeferStartedAt: number | null = null;

  /** Max time to defer the live-area flush while inside an open structure. */
  private static readonly MAX_ADAPTIVE_WAIT_MS = 2000;

  constructor(
    private readonly agentName: string,
    private readonly showMetrics: boolean,
    private readonly displayConfig: DisplayConfig,
    streamingConfig?: { textBufferMs?: number },
    throttleMs?: number,
    private readonly streamTarget: StreamTarget = { kind: "scrollback" },
  ) {
    this.updateThrottleMs = throttleMs ?? 60;
    this.textBufferMs =
      streamingConfig?.textBufferMs ?? InkStreamingRenderer.DEFAULT_TEXT_BUFFER_MS;
    this.acc = createAccumulator(agentName);
    store.setCollapseReasoning(displayConfig.collapseReasoning !== false);
  }

  /**
   * Dispatch a buffered delta to its target — `appendStream` for scrollback
   * or `appendEphemeral` for a panel region.
   */
  private dispatchBufferedDelta(entry: BufferedStreamDelta): void {
    if (entry.target === "stream") {
      store.appendStream(entry.kind, entry.delta);
    } else {
      store.appendEphemeral(entry.regionId, entry.delta);
    }
  }

  /**
   * Append a streaming delta to the in-memory buffer. Schedules a flush
   * within `textBufferMs` if one isn't already pending. With
   * `textBufferMs: 0` the delta flushes synchronously, matching the
   * pre-buffering behavior for callers that opt out.
   */
  private bufferStreamDelta(entry: BufferedStreamDelta): void {
    if (entry.delta.length === 0) return;
    if (this.textBufferMs <= 0) {
      this.dispatchBufferedDelta(entry);
      return;
    }

    // Track cumulative response text for adaptive structure-aware buffering
    // (#218). Only the main agent's response stream feeds the heuristic —
    // ephemeral panels (reasoning, sub-agent) render in bounded regions
    // where partial table/code rendering doesn't cause shifting layout.
    if (entry.target === "stream" && entry.kind === "response") {
      this.cumulativeResponseText += entry.delta;
    }

    this.streamBuffer.push(entry);
    if (this.streamFlushTimeoutId !== null) return;

    this.scheduleBufferFlush(this.textBufferMs);
  }

  /**
   * Render a sub-agent's tool activity as compact plain-text lines in its
   * bounded ephemeral panel so the region's last-N-lines cap crops them the
   * same way it crops reasoning, instead of growing unbounded in scrollback.
   * `tools_detected` is dropped as redundant with the per-tool start lines.
   */
  private appendToolActivityToEphemeral(
    event: StreamEvent,
    regionId: string,
    completedToolName: string | undefined,
  ): void {
    if (event.type === "tool_execution_start") {
      const args = formatToolArguments(
        event.toolName,
        event.arguments,
        event.metadata !== undefined ? { metadata: event.metadata } : undefined,
      );
      const displayName = formatToolDisplayName(event.toolName, event.metadata);
      const line = `${displayName}${args.length > 0 ? ` ${args}` : ""}`;
      // Leading newline so the line starts its own row rather than merging
      // onto a partial reasoning line already in the region.
      this.bufferStreamDelta({ target: "ephemeral", regionId, delta: `\n${line}` });
      return;
    }
    if (event.type === "tool_execution_complete") {
      const failed = event.success === false;
      const summary = failed
        ? `${completedToolName ? `${completedToolName}: ` : ""}${event.error?.trim() || "Tool execution failed"}`
        : event.summary?.trim() ||
          (completedToolName ? formatToolResult(completedToolName, event.result) : "") ||
          completedToolName ||
          "Tool";
      const firstLine = summary.split("\n")[0] ?? summary;
      const glyph = failed ? getGlyphs().error : getGlyphs().success;
      const line = `${glyph} ${firstLine} (${event.durationMs}ms)`;
      this.bufferStreamDelta({ target: "ephemeral", regionId, delta: `\n${line}` });
    }
  }

  /**
   * Schedule a flush. The handler checks the open-structure heuristic before
   * flushing: if we're mid-table or mid-code-fence (and within the adaptive
   * wait cap), reschedule for another `textBufferMs` window so partial
   * structured content doesn't render incrementally.
   */
  private scheduleBufferFlush(delayMs: number): void {
    this.streamFlushTimeoutId = setTimeout(() => {
      this.streamFlushTimeoutId = null;

      if (this.shouldDeferForOpenStructure()) {
        this.scheduleBufferFlush(this.textBufferMs);
        return;
      }

      this.adaptiveDeferStartedAt = null;
      this.flushStreamBuffer();
    }, delayMs);
  }

  /**
   * True when the next flush should be deferred because the cumulative
   * response text ends inside an open markdown structure. Capped by
   * MAX_ADAPTIVE_WAIT_MS so a runaway open structure (e.g. a 200-line code
   * block) doesn't keep the live area silent indefinitely.
   */
  private shouldDeferForOpenStructure(): boolean {
    if (!isInsideOpenStructure(this.cumulativeResponseText)) return false;
    if (this.adaptiveDeferStartedAt === null) {
      this.adaptiveDeferStartedAt = Date.now();
      return true;
    }
    return Date.now() - this.adaptiveDeferStartedAt < InkStreamingRenderer.MAX_ADAPTIVE_WAIT_MS;
  }

  /**
   * Flush any buffered streaming deltas immediately. Called whenever we
   * need on-screen content to be in sync (kind transitions, completion,
   * abort, reset, etc.) so we never lose a tail.
   *
   * Coalesces consecutive entries that target the same destination
   * (same scrollback kind, or same ephemeral region id) into a single
   * append call, so the underlying store sees one update per run instead
   * of one per token.
   */
  private flushStreamBuffer(): void {
    if (this.streamFlushTimeoutId !== null) {
      clearTimeout(this.streamFlushTimeoutId);
      this.streamFlushTimeoutId = null;
    }
    // Manual flush short-circuits adaptive deferral — drop the wait timer.
    this.adaptiveDeferStartedAt = null;
    if (this.streamBuffer.length === 0) return;
    const buffered = this.streamBuffer;
    this.streamBuffer = [];

    let run: BufferedStreamDelta | null = null;
    for (const entry of buffered) {
      if (run === null) {
        run = entry;
        continue;
      }
      if (sameBufferTarget(run, entry)) {
        run = { ...run, delta: run.delta + entry.delta };
      } else {
        this.dispatchBufferedDelta(run);
        run = entry;
      }
    }
    if (run !== null && run.delta.length > 0) {
      this.dispatchBufferedDelta(run);
    }
  }

  reset(): Effect.Effect<void, never> {
    return Effect.sync(() => {
      this.acc.activeTools.clear();
      this.acc.isThinking = false;
      this.acc.lastAgentHeaderWritten = false;
      this.acc.lastAppliedTextSequence = -1;
      this.seenLength = 0;
      this.hasStreamedText = false;
      this.cumulativeResponseText = "";
      this.lastUpdateTime = 0;
      this.pendingActivity = null;
      if (this.updateTimeoutId) {
        clearTimeout(this.updateTimeoutId);
        this.updateTimeoutId = null;
      }
      this.clearAllToolTimeouts();
      // Flush buffered deltas BEFORE collapsing the reasoning region so any
      // in-flight reasoning text lands in the panel before it collapses.
      this.flushStreamBuffer();
      this.collapseReasoningRegion();
      store.finalizeStream();
      store.setActivity({ phase: "idle" });
      store.setInterruptHandler(null);
      store.setBackgroundHandler(null);
    });
  }

  flush(): Effect.Effect<void, never> {
    return Effect.sync(() => {
      if (this.updateTimeoutId) {
        clearTimeout(this.updateTimeoutId);
        this.updateTimeoutId = null;
      }
      this.pendingActivity = null;
      this.clearAllToolTimeouts();
      this.acc.activeTools.clear();
      // Flush buffered deltas BEFORE collapsing the reasoning region so any
      // in-flight reasoning text lands in the panel before it collapses.
      this.flushStreamBuffer();
      this.collapseReasoningRegion();
      store.finalizeStream();
      store.setActivity({ phase: "idle" });
      store.setInterruptHandler(null);
      store.setBackgroundHandler(null);
    });
  }

  setInterruptHandler(handler: (() => void) | null): Effect.Effect<void, never> {
    return Effect.sync(() => {
      store.setInterruptHandler(handler);
    });
  }

  setBackgroundHandler(handler: (() => void) | null): Effect.Effect<void, never> {
    return Effect.sync(() => {
      store.setBackgroundHandler(handler);
    });
  }

  /**
   * Events that should finalize the pending streaming buffer before the rest
   * of `handleEvent` runs. Centralizes the settle-before-emit rule so any
   * non-streaming event that may emit visible output cannot interleave with
   * an open pending tail.
   *
   * Excluded from this list:
   * - `text_chunk` / `thinking_chunk`: stream events; they extend pending in place.
   * - `stream_start` / `thinking_start`: round/phase boundaries; pending is
   *   expected to be null at these points (prior round's `complete`/`error`/
   *   `flush` finalized it).
   * - `complete`: settled inside `handleComplete`, where the surrounding
   *   metrics/cost/idle work needs to come AFTER the finalize.
   * - `usage_update`: no visible output; settling here would prematurely commit
   *   the pending tail to scrollback when usage events fire mid-stream.
   */
  private static readonly SETTLE_BEFORE: ReadonlySet<StreamEvent["type"]> = new Set([
    "thinking_complete",
    "text_start",
    "tools_detected",
    "tool_execution_start",
    "tool_execution_complete",
    "error",
  ]);

  /**
   * Events that should close any open reasoning panel. Once the model
   * transitions out of reasoning (into response or tools), the panel
   * collapses to a one-line summary. The full reasoning text is captured
   * into the store's expandable-reasoning slot so Ctrl-R can re-emit it.
   */
  private static readonly COLLAPSE_REASONING_BEFORE: ReadonlySet<StreamEvent["type"]> = new Set([
    "thinking_complete",
    "text_start",
    "tools_detected",
    "tool_execution_start",
    "error",
  ]);

  /** Collapse the active reasoning panel (if any) with a duration+token summary. */
  private collapseReasoningRegion(tokens?: number): void {
    if (this.reasoningRegionId === null) return;

    const durationMs = Date.now() - this.reasoningStartedAt;
    const seconds = (durationMs / 1000).toFixed(1);
    const tokenSegment = tokens !== undefined ? ` · ${tokens} tokens` : "";
    const line = chalk.dim(
      chalk.italic(
        `${getGlyphs().success} Reasoning · ${seconds}s${tokenSegment} · ctrl+r to expand`,
      ),
    );

    store.collapseEphemeral(this.reasoningRegionId, {
      line,
      fullText: this.reasoningFullText,
      durationMs,
      ...(tokens !== undefined && { tokens }),
    });

    this.reasoningRegionId = null;
    this.reasoningFullText = "";
    this.reasoningStartedAt = 0;
  }

  handleEvent(event: StreamEvent): Effect.Effect<void, never> {
    return Effect.sync(() => {
      if (InkStreamingRenderer.SETTLE_BEFORE.has(event.type)) {
        // Flush any in-flight buffered deltas BEFORE finalizing the stream
        // so they land in the slice that's about to settle, not the next one.
        this.flushStreamBuffer();
        store.finalizeStream();
      }

      // Close any open reasoning panel before non-reasoning events. Tokens
      // aren't available until usage_update / complete; collapse with a
      // duration-only summary now and let later events refine if needed.
      if (
        this.streamTarget.kind === "scrollback" &&
        InkStreamingRenderer.COLLAPSE_REASONING_BEFORE.has(event.type)
      ) {
        this.collapseReasoningRegion();
      }

      if (event.type === "stream_start") {
        this.seenLength = 0;
        this.hasStreamedText = false;
        store.updateRunStats({ provider: event.provider, model: event.model });
        this.resolveContextWindow(event.provider, event.model, event.pinnedContextWindow);
      }

      if (this.displayConfig.showReasoning) {
        if (event.type === "thinking_start") {
          if (this.streamTarget.kind === "ephemeral") {
            // Subagent reasoning lives in the subagent's own panel — no
            // separate reasoning region.
          } else if (this.reasoningRegionId === null) {
            this.reasoningRegionId = store.openEphemeral(
              "reasoning",
              "Reasoning",
              InkStreamingRenderer.reasoningPanelLines(),
            );
            this.reasoningFullText = "";
            this.reasoningStartedAt = Date.now();
          }
        }
        if (event.type === "thinking_chunk") {
          if (this.streamTarget.kind === "ephemeral") {
            // Sub-agent reasoning streams into the sub-agent's own panel.
            this.bufferStreamDelta({
              target: "ephemeral",
              regionId: this.streamTarget.regionId,
              delta: event.content,
            });
          } else {
            // Main-agent reasoning streams into its own dedicated panel.
            // Open lazily if a chunk somehow arrives without thinking_start.
            if (this.reasoningRegionId === null) {
              this.reasoningRegionId = store.openEphemeral(
                "reasoning",
                "Reasoning",
                InkStreamingRenderer.reasoningPanelLines(),
              );
              this.reasoningStartedAt = Date.now();
              this.reasoningFullText = "";
            }
            this.reasoningFullText += event.content;
            this.bufferStreamDelta({
              target: "ephemeral",
              regionId: this.reasoningRegionId,
              delta: event.content,
            });
          }
        }
      }

      if (event.type === "complete") {
        this.handleComplete(event);
        return;
      }

      if (event.type === "tool_execution_start" && !event.longRunning) {
        this.setupToolTimeout(event.toolCallId, event.toolName);
      }
      // Read before reduceEvent clears the entry on completion; the panel
      // line needs the tool name to format its result summary.
      const completedToolName =
        event.type === "tool_execution_complete"
          ? this.acc.activeTools.get(event.toolCallId)?.toolName
          : undefined;
      if (event.type === "tool_execution_complete") {
        this.clearToolTimeout(event.toolCallId);
        this.storeExpandableDiff(completedToolName, event.result);
      }
      if (event.type === "error") {
        this.clearAllToolTimeouts();
        this.acc.activeTools.clear();
      }

      const result = reduceEvent(this.acc, event, ink);

      // Sub-agent tool activity goes into its bounded panel (capped height)
      // rather than unbounded scrollback; non-tool outputs (errors, headers)
      // still reach scrollback so failures aren't cropped away.
      const isSubagentToolEvent =
        this.streamTarget.kind === "ephemeral" &&
        (event.type === "tools_detected" ||
          event.type === "tool_execution_start" ||
          event.type === "tool_execution_complete");

      if (isSubagentToolEvent && this.streamTarget.kind === "ephemeral") {
        this.appendToolActivityToEphemeral(event, this.streamTarget.regionId, completedToolName);
      } else {
        for (const entry of result.outputs) {
          store.printOutput(entry);
        }
      }

      if (event.type === "text_start") {
        // Reasoning was finalized by thinking_complete (or there was none).
        // Reset stream-text bookkeeping for the new response stream.
        this.seenLength = 0;
        this.hasStreamedText = false;
        // The cumulative response text only matters within a single
        // response stream — drop it so the open-structure heuristic sees
        // a clean buffer for the new turn.
        this.cumulativeResponseText = "";
      }

      if (event.type === "text_chunk") {
        const delta = this.consumeTextDelta(event);
        if (delta.length > 0) {
          if (this.streamTarget.kind === "ephemeral") {
            // Sub-agent response streams into the sub-agent's own panel.
            this.bufferStreamDelta({
              target: "ephemeral",
              regionId: this.streamTarget.regionId,
              delta,
            });
          } else {
            // Main-agent response streams into the global scrollback.
            this.bufferStreamDelta({ target: "stream", kind: "response", delta });
          }
          this.hasStreamedText = true;
        }
      }

      if (result.activity) {
        const phase = result.activity.phase;
        if (phase === "thinking" || phase === "streaming") {
          this.throttledSetActivity(result.activity);
        } else {
          this.lastUpdateTime = Date.now();
          this.pendingActivity = null;
          store.setActivity(result.activity);
        }
      }
    }).pipe(
      Effect.catchAllDefect((defect) =>
        Effect.sync(() => {
          const message = defect instanceof Error ? defect.message : String(defect);
          store.printOutput({
            type: "warn",
            message: `Stream rendering error (${event.type}): ${message}`,
            timestamp: new Date(),
          });
        }),
      ),
    );
  }

  private handleComplete(event: Extract<StreamEvent, { type: "complete" }>): void {
    if (this.updateTimeoutId) {
      clearTimeout(this.updateTimeoutId);
      this.updateTimeoutId = null;
      this.pendingActivity = null;
    }

    // Drain buffered deltas + close any open reasoning panel before the
    // turn settles, so neither leaves a hanging tail in scrollback.
    this.flushStreamBuffer();
    this.collapseReasoningRegion();
    store.finalizeStream();
    // A complete event is the terminal boundary for the renderer, even when
    // an execution path did not deliver a matching tool completion event.
    // Clear the accumulator so a tool from this turn cannot reappear when the
    // renderer is reused for the next turn.
    this.acc.activeTools.clear();

    if (!this.hasStreamedText) {
      this.printFinalResponse(event);
    }

    if (this.showMetrics && event.metrics) {
      if (this.streamTarget.kind === "scrollback") {
        store.printOutput({ type: "log", message: "", timestamp: new Date() });
      }
      this.printOutro(event);
    }

    store.setActivity({ phase: "idle" });
    // Defensive reset so a reused renderer instance starts clean even if no
    // text_start fires before the next text_chunk.
    this.seenLength = 0;
    this.hasStreamedText = false;
    this.cumulativeResponseText = "";
  }

  /** Compute the new portion of the accumulated stream text, based on seenLength. */
  private consumeTextDelta(event: Extract<StreamEvent, { type: "text_chunk" }>): string {
    if (event.sequence !== this.acc.lastAppliedTextSequence) return "";
    const next = event.accumulated;
    if (next.length <= this.seenLength) return "";
    const delta = next.slice(this.seenLength);
    this.seenLength = next.length;
    return delta;
  }

  private printFinalResponse(event: Extract<StreamEvent, { type: "complete" }>): void {
    const wasStreaming = this.acc.lastAgentHeaderWritten;
    const fullContent = event.response.content?.trim() ?? "";
    if (fullContent.length === 0) return;
    const formattedFull = this.formatMarkdownContent(fullContent);
    if (formattedFull.length === 0) return;

    if (wasStreaming) {
      store.printOutput({
        type: "streamContent",
        message: formattedFull,
        timestamp: new Date(),
      });
    } else {
      store.printOutput({
        type: "info",
        message: this.agentName,
        timestamp: new Date(),
      });
      store.printOutput({
        type: "log",
        message: ink(
          React.createElement(AgentResponseCard, {
            agentName: this.agentName,
            content: formattedFull,
          }),
        ),
        // The message above renders only in an Ink-based terminal — it is an
        // opaque React element to anything else. `formattedFull` is the actual
        // text and travels alongside it in meta, so a non-Ink renderer has a
        // real answer to show instead of an unrenderable object.
        meta: { plainText: formattedFull },
        timestamp: new Date(),
      });
    }
  }

  /**
   * The turn outro: ONE quiet line closing the turn —
   * `✓ 4.2s · 9.3k in → 28 out · $0.0019` — replacing the old trio of
   * metrics line, cost line, and "completed successfully" banner.
   *
   * Cost joins the line when pricing is in the synchronous cache (the common
   * case); on a cold cache the footer still gets the async update, but no
   * late line is printed after the prompt has already returned.
   */
  private printOutro(event: Extract<StreamEvent, { type: "complete" }>): void {
    const parts: string[] = [];
    if (event.totalDurationMs > 0) {
      parts.push(`${(event.totalDurationMs / 1000).toFixed(1)}s`);
    }

    const usage = event.response.usage;
    if (usage) {
      const cacheReadTokens = Math.min(usage.cacheReadTokens ?? 0, usage.promptTokens);
      const cachedShare =
        usage.promptTokens > 0 && cacheReadTokens > 0
          ? ` (${Math.round((cacheReadTokens / usage.promptTokens) * 100)}% cached)`
          : "";
      parts.push(
        `${compactCount(usage.promptTokens)} in${cachedShare} → ${compactCount(usage.completionTokens)} out`,
      );
      // Push the prompt-side count to the persistent footer so users have
      // visibility on context-window pressure between turns.
      this.acc.lastPromptTokens = usage.promptTokens;
      store.updateRunStats({ tokensInContext: usage.promptTokens });
      store.addSessionUsage({
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
      });
    } else if (event.metrics?.totalTokens) {
      parts.push(`${compactCount(event.metrics.totalTokens)} tok`);
    }

    const provider = this.acc.currentProvider;
    const model = this.acc.currentModel;
    if (usage && provider && model) {
      const computeCost = (meta: UsageCostPricing | undefined): number | null =>
        computeUsageCostUSD(usage, meta);
      const rollIntoFooter = (totalCost: number): void => {
        this.acc.cumulativeCostUSD += totalCost;
        // Accumulate into the shared session total so sub-agent renderers add
        // to the footer rather than overwriting it with their own figure.
        store.addSessionCostUSD(totalCost);
        // Only the main-agent (scrollback) renderer owns the footer's model/
        // provider label; sub-agent renderers contribute cost but must not
        // relabel the footer with their (often different) model.
        if (this.streamTarget.kind === "scrollback") {
          store.updateRunStats({ model, provider });
        }
      };

      const cachedMeta = getModelsDevMetadataSync(model, provider);
      if (cachedMeta !== undefined) {
        const totalCost = computeCost(cachedMeta);
        if (totalCost !== null) {
          rollIntoFooter(totalCost);
          parts.push(formatOutroCost(totalCost));
        }
      } else {
        // Cold cache: keep the footer accurate without printing a straggler
        // line after the prompt has returned.
        void getModelsDevMetadata(model, provider)
          .then((meta) => {
            const totalCost = computeCost(meta);
            if (totalCost !== null) rollIntoFooter(totalCost);
          })
          .catch(() => {
            /* pricing unavailable */
          });
      }
    }

    if (parts.length === 0) return;

    const line = `${getGlyphs().success} ${parts.join(" · ")}`;
    if (this.streamTarget.kind === "ephemeral") {
      this.bufferStreamDelta({
        target: "ephemeral",
        regionId: this.streamTarget.regionId,
        delta: `\n${line}`,
      });
      return;
    }

    store.printOutput({
      type: "debug",
      message: line,
      timestamp: new Date(),
    });
  }

  /**
   * Resolve the context window the request will actually get and publish it to the
   * footer, so tokens-in-context renders as `12.3k/200k` instead of a bare count —
   * and so the denominator matches the one compaction accounts against.
   */
  private resolveContextWindow(
    provider: string,
    model: string,
    pinnedContextWindow: number | undefined,
  ): void {
    const publish = (modelMaxTokens: number | undefined): void => {
      const effective = resolveEffectiveContextWindow({
        provider,
        ...(modelMaxTokens !== undefined && { modelMaxTokens }),
        ...(pinnedContextWindow !== undefined && { pinnedContextWindow }),
      });
      store.updateRunStats({ maxContextTokens: effective.tokens });
    };

    const cached = getModelsDevMetadataSync(model, provider);
    if (cached !== undefined) {
      publish(cached.contextWindow);
      return;
    }
    // A pinned window stands on its own: the catalog has no local-provider entry
    // to wait for, and the footer must not show the maximum the run is not getting.
    if (pinnedContextWindow !== undefined) {
      publish(undefined);
    }
    void getModelsDevMetadata(model, provider)
      .then((meta) => {
        if (meta === undefined) return;
        // Guard against a stale write: if the user switched models while the
        // fetch was in flight, this response no longer describes the active
        // model and must not overwrite the footer denominator.
        const stats = store.getRunStatsSnapshot();
        if (stats.model !== model || stats.provider !== provider) return;
        publish(meta.contextWindow);
      })
      .catch(() => {
        /* context window unavailable — footer shows the bare count */
      });
  }

  private setupToolTimeout(toolCallId: string, toolName: string): void {
    const startedAt = Date.now();
    const warn = (): void => {
      if (!this.acc.activeTools.has(toolCallId)) return;
      const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
      store.printOutput({
        type: "warn",
        message: `Tool ${toolName} still running after ${elapsedSeconds}s (press Esc twice to interrupt)`,
        timestamp: new Date(),
      });
      // Re-arm so multi-minute tools keep reassuring the user instead of
      // going silent after a single warning.
      const timeoutId = setTimeout(warn, InkStreamingRenderer.TOOL_WARNING_MS);
      this.toolTimeouts.set(toolCallId, timeoutId);
    };
    const timeoutId = setTimeout(warn, InkStreamingRenderer.TOOL_WARNING_MS);
    this.toolTimeouts.set(toolCallId, timeoutId);
  }

  private clearToolTimeout(toolCallId: string): void {
    const timeoutId = this.toolTimeouts.get(toolCallId);
    if (timeoutId) {
      clearTimeout(timeoutId);
      this.toolTimeouts.delete(toolCallId);
    }
  }

  private clearAllToolTimeouts(): void {
    for (const timeoutId of this.toolTimeouts.values()) {
      clearTimeout(timeoutId);
    }
    this.toolTimeouts.clear();
  }

  private storeExpandableDiff(toolName: string | undefined, result: string): void {
    if (toolName !== undefined && isFileMutationTool(toolName)) {
      const mutationPayload = expandableFileMutationPayload(result);
      if (mutationPayload !== null) {
        store.setExpandableDiff(mutationPayload);
      }
      return;
    }

    // Generic tools: when the on-screen summary truncates the result, keep
    // the full text expandable via the same Ctrl+O affordance as diffs.
    const payload = expandableToolResultPayload(result);
    if (payload !== null) {
      store.setExpandableDiff(payload);
    }
  }

  /**
   * Throttled activity state update. Limits React re-renders to once per
   * UPDATE_THROTTLE_MS while always flushing the latest pending state.
   *
   * Streaming response text is stored RAW by the reducer and only formatted
   * (markdown + wrapping + padding) here, right before pushing to the store.
   * This avoids expensive formatting on every token (~80/sec) — it only
   * happens at the throttle rate (~10/sec).
   */
  private throttledSetActivity(activity: ActivityState): void {
    const now = Date.now();
    const timeSinceLastUpdate = now - this.lastUpdateTime;

    if (timeSinceLastUpdate < this.updateThrottleMs) {
      // Always store the latest activity so the timer flushes the newest state
      this.pendingActivity = activity;
      if (!this.updateTimeoutId) {
        const delay = this.updateThrottleMs - timeSinceLastUpdate;
        this.updateTimeoutId = setTimeout(() => {
          this.updateTimeoutId = null;
          this.lastUpdateTime = Date.now();
          if (this.pendingActivity) {
            const nextActivity = this.pendingActivity;
            this.pendingActivity = null;
            store.flushOutputBatchNow();
            store.setActivity(nextActivity);
          }
        }, delay);
      }
      return;
    }

    this.lastUpdateTime = now;
    this.pendingActivity = null;
    store.flushOutputBatchNow();
    store.setActivity(activity);
  }

  /** Apply markdown formatting based on display mode (no wrapping). */
  private formatMarkdownContent(text: string): string {
    if (this.displayConfig.mode === "rendered") {
      return formatMarkdown(text);
    }
    if (this.displayConfig.mode === "hybrid") {
      return formatMarkdownHybrid(text);
    }
    return text;
  }
}

/**
 * Queued approval request with its resolve callback.
 */
interface QueuedApproval {
  request: ApprovalRequest;
  resume: (effect: Effect.Effect<ApprovalOutcome, never>) => void;
}

/**
 * Queued user input request with its resolve callback.
 */
interface QueuedUserInput {
  request: UserInputRequest;
  resume: (effect: Effect.Effect<UserInputOutcome, never>) => void;
}

/**
 * Ink implementation of PresentationService.
 *
 * Critical: does NOT write to stdout directly (which would clobber Ink rendering).
 * Instead, it pushes output into the Ink store.
 */
export class InkPresentationService implements PresentationService {
  // Approval queue to handle parallel tool calls
  private approvalQueue: QueuedApproval[] = [];
  private isProcessingApproval: boolean = false;

  // User input queue to handle parallel requestUserInput calls
  private userInputQueue: QueuedUserInput[] = [];
  private isProcessingUserInput: boolean = false;

  // Signal for tool execution start synchronization
  private pendingExecutionSignal: (() => void) | null = null;

  constructor(
    private readonly displayConfig: DisplayConfig,
    private readonly notificationService: NotificationService | null,
  ) {
    store.setCollapseReasoning(displayConfig.collapseReasoning !== false);
  }

  /** Format markdown using the display mode from config. No pre-wrapping. */
  private formatMarkdownText(text: string): string {
    if (this.displayConfig.mode === "rendered") {
      return formatMarkdown(text);
    }
    if (this.displayConfig.mode === "hybrid") {
      return formatMarkdownHybrid(text);
    }
    return text;
  }

  presentThinking(agentName: string, _isFirstIteration: boolean): Effect.Effect<void, never> {
    return Effect.sync(() => {
      store.setActivity({
        phase: "thinking",
        agentName,
      });
    });
  }

  presentCompletion(_agentName: string): Effect.Effect<void, never> {
    // Intentionally silent: the turn outro line (duration · tokens · cost)
    // already marks completion — a second "completed successfully" banner
    // was pure noise.
    return Effect.void;
  }

  presentWarning(agentName: string, message: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      store.printOutput({
        type: "warn",
        message: formatWarning(agentName, message),
        timestamp: new Date(),
      });
    });
  }

  presentAgentResponse(agentName: string, content: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      const header = CHALK_THEME.primaryBold(`${getGlyphs().active} ${agentName}:`);
      const rendered = this.formatMarkdownText(content);
      store.printOutput({
        type: "log",
        message: `${header}\n${rendered}`,
        timestamp: new Date(),
      });
    });
  }

  renderMarkdown(markdown: string): Effect.Effect<string, never> {
    return Effect.sync(() => this.formatMarkdownText(markdown));
  }

  formatToolArguments(toolName: string, args?: Record<string, unknown>): string {
    return formatToolArguments(toolName, args);
  }

  formatToolResult(toolName: string, result: string): string {
    return formatToolResult(toolName, result);
  }

  formatToolExecutionStart(
    toolName: string,
    args?: Record<string, unknown>,
    options?: { metadata?: Record<string, unknown> },
  ): Effect.Effect<string, never> {
    const formatArgsOpts =
      options?.metadata !== undefined ? { metadata: options.metadata } : undefined;
    return formatToolExecutionStartEffect(
      formatToolDisplayName(toolName, options?.metadata),
      formatToolArguments(toolName, args, formatArgsOpts),
    );
  }

  formatToolExecutionComplete(
    summary: string | null,
    durationMs: number,
  ): Effect.Effect<string, never> {
    return formatToolExecutionCompleteEffect(summary, durationMs);
  }

  formatToolExecutionError(errorMessage: string, durationMs: number): Effect.Effect<string, never> {
    return formatToolExecutionErrorEffect(errorMessage, durationMs);
  }

  formatToolsDetected(
    agentName: string,
    toolNames: readonly string[],
    toolsRequiringApproval: readonly string[],
  ): Effect.Effect<string, never> {
    return formatToolsDetectedEffect(agentName, toolNames, toolsRequiringApproval);
  }

  createStreamingRenderer(
    config: StreamingRendererConfig,
  ): Effect.Effect<StreamingRenderer, never> {
    return Effect.sync(() => {
      return new InkStreamingRenderer(
        config.agentName,
        config.showMetrics,
        config.displayConfig,
        config.streamingConfig,
        undefined,
        config.streamTarget ?? { kind: "scrollback" },
      );
    });
  }

  writeOutput(message: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      store.printOutput({ type: "log", message, timestamp: new Date() });
    });
  }

  writeBlankLine(): Effect.Effect<void, never> {
    return Effect.sync(() => {
      store.printOutput({ type: "log", message: "", timestamp: new Date() });
    });
  }

  presentStatus(
    message: string,
    level: "info" | "success" | "warning" | "error" | "progress",
  ): Effect.Effect<void, never> {
    return Effect.sync(() => {
      const glyphs = getGlyphs();
      const icons: Record<typeof level, { icon: string; color: string }> = {
        info: { icon: glyphs.info, color: "blue" },
        success: { icon: glyphs.success, color: "green" },
        warning: { icon: glyphs.warn, color: "yellow" },
        error: { icon: glyphs.error, color: "red" },
        progress: { icon: glyphs.pending, color: "cyan" },
      };
      const { icon, color } = icons[level];
      const colorFn = chalk[color as keyof typeof chalk] as (s: string) => string;
      const formatted = `${colorFn(icon)} ${message}`;
      const type = level === "error" ? "error" : level === "warning" ? "warn" : "info";
      store.printOutput({ type, message: formatted, timestamp: new Date() });
    });
  }

  openEphemeralRegion(kind: EphemeralRegionKind, label: string): Effect.Effect<string, never> {
    return Effect.sync(() =>
      store.openEphemeral(kind, label, kind === "subagent" ? SUBAGENT_PANEL_LINES : 8),
    );
  }

  appendEphemeralRegion(regionId: string, text: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      store.appendEphemeral(regionId, text);
    });
  }

  collapseEphemeralRegion(
    regionId: string,
    label: string,
    outcome: EphemeralRegionCollapse,
  ): Effect.Effect<void, never> {
    return Effect.sync(() => {
      store.collapseEphemeral(regionId, {
        line: formatSubagentCollapseLine(label, outcome),
        durationMs: outcome.durationMs,
      });
    });
  }

  requestApproval(request: ApprovalRequest): Effect.Effect<ApprovalOutcome, never> {
    return Effect.async((resume) => {
      // Add to queue and process
      this.approvalQueue.push({ request, resume });
      this.processNextApproval();
    });
  }

  /**
   * Resumes the approval effect with the given outcome.
   * Waits for tool execution to start before processing the next approval.
   */
  private completeApproval(
    resume: (effect: Effect.Effect<ApprovalOutcome, never>) => void,
    outcome: ApprovalOutcome,
  ): void {
    resume(Effect.succeed(outcome));

    // If approved, wait for the tool execution to start before processing next approval
    // If rejected, we can proceed immediately since no tool will execute
    if (outcome.approved) {
      // Set up a signal that will be triggered by signalToolExecutionStarted
      this.pendingExecutionSignal = () => {
        this.pendingExecutionSignal = null;
        this.isProcessingApproval = false;
        this.processNextApproval();
      };
    } else {
      // No tool execution for rejected approvals, proceed immediately
      this.isProcessingApproval = false;
      this.processNextApproval();
    }
  }

  /**
   * Process the next approval request in the queue.
   * Only one approval prompt is shown at a time to avoid overwriting.
   */
  private processNextApproval(): void {
    // If already processing or queue is empty, do nothing
    if (this.isProcessingApproval || this.approvalQueue.length === 0) {
      return;
    }

    this.isProcessingApproval = true;
    const { request, resume } = this.approvalQueue.shift()!;

    // Re-check auto-approve status at dequeue time. A parallel tool's
    // "always approve" choice may have updated the shared allowlist while
    // this request was waiting in the queue.
    if (request.isAutoApproved?.()) {
      resume(Effect.succeed({ approved: true as const }));
      this.isProcessingApproval = false;
      this.processNextApproval();
      return;
    }

    // Send system notification for approval request.
    if (this.notificationService) {
      Effect.runFork(
        this.notificationService
          .notify(`Agent needs approval for ${request.toolName}`, {
            title: "Jazz Approval Required",
            sound: true,
          })
          .pipe(
            Effect.catchAll((error) => {
              console.error("[Notification] Failed to send approval notification:", error);
              return Effect.void;
            }),
          ),
      );
    }

    // Format the approval message as an Ink bordered card
    const pendingCount = this.approvalQueue.length;

    const isPicker = (request.options?.length ?? 0) > 0;

    const approvalCard = React.createElement(
      Box,
      {
        flexDirection: "column",
        borderStyle: "round",
        borderColor: THEME.warning,
        paddingX: PADDING.content,
        paddingY: 1,
        marginTop: 1,
      },
      React.createElement(
        Box,
        {},
        React.createElement(
          Text,
          { color: THEME.warning, bold: true },
          isPicker ? "Pick a model" : "Approval Required",
        ),
        isPicker
          ? React.createElement(Text, { dimColor: true }, `  ${request.toolName}`)
          : React.createElement(Text, {}, " for "),
        !isPicker &&
          React.createElement(Text, { color: THEME.primary, bold: true }, request.toolName),
        pendingCount > 0
          ? React.createElement(Text, { dimColor: true }, ` (${pendingCount} more pending)`)
          : null,
      ),
      React.createElement(
        Box,
        { marginTop: 1 },
        React.createElement(Text, { bold: true }, request.message),
      ),
      // Never let users approve a file edit blind: point at the diff.
      request.previewDiff
        ? React.createElement(
            Box,
            { marginTop: 1 },
            React.createElement(Text, { dimColor: true }, "Press Ctrl+O to view the diff"),
          )
        : null,
    );

    store.printOutput({
      type: "log",
      message: ink(approvalCard),
      timestamp: new Date(),
    });

    // Store preview diff for Ctrl+O expansion
    if (request.previewDiff) {
      store.setExpandableDiff(request.previewDiff);
    }

    // Build approval choices — all tools get "always approve <tool>" option,
    // execute_command also gets "always approve <command>" option
    const toolDisplayName = request.toolName;
    const rawCommand =
      request.toolName === "execute_command"
        ? typeof request.executeArgs["command"] === "string"
          ? request.executeArgs["command"]
          : null
        : null;

    // Extract a subcommand-level approval key (e.g. "git diff" instead of
    // "git diff --name-only") so one approval covers all flag variants.
    const approvalKey = rawCommand ? extractCommandApprovalKey(rawCommand) : null;

    // Picker-style request: the human chooses *which* capable model handles the work,
    // or declines. "Always approve" choices are deliberately absent — picking a row is
    // the whole decision, and there is nothing sensible to remember for next time.
    if (isPicker && request.options) {
      const pickerChoices: Array<{ label: string; value: string }> = request.options.map(
        (option) => ({
          label: option.detail ? `${option.label}  —  ${option.detail}` : option.label,
          value: option.id,
        }),
      );
      pickerChoices.push({ label: "No, don't delegate", value: "__decline__" });

      store.setPrompt({
        type: "select",
        message: "Pick a model",
        options: { choices: pickerChoices },
        resolve: (val: unknown) => {
          const choice = val as string;
          store.setPrompt(null);
          store.setApprovalRequest(null);
          store.printOutput({
            type: "log",
            message: `Pick a model: ${
              choice === "__decline__"
                ? CHALK_THEME.error("No")
                : CHALK_THEME.success(
                    request.options?.find((o) => o.id === choice)?.label ?? choice,
                  )
            }`,
            timestamp: new Date(),
          });

          if (choice === "__decline__") {
            this.promptRejectionMessage(resume);
            return;
          }
          this.completeApproval(resume, { approved: true, selectedOptionId: choice });
        },
      });
      return;
    }

    const choices: Array<{ label: string; value: string }> = [{ label: "Yes", value: "yes" }];

    if (approvalKey) {
      const truncatedKey = approvalKey.length > 60 ? approvalKey.slice(0, 57) + "..." : approvalKey;
      choices.push({
        label: `Yes, and always approve "${truncatedKey}" for this session`,
        value: "always_command",
      });
    }

    choices.push({
      label: `Yes, and always approve ${toolDisplayName} for this session`,
      value: "always_tool",
    });

    choices.push({ label: "No", value: "no" });

    // Publish the request itself alongside the menu. The fullscreen approval
    // card needs the account, the resulting fields and the consequence, none of
    // which survive being flattened into a list of choices.
    store.setApprovalRequest({
      toolName: request.toolName,
      executeToolName: request.executeToolName,
      message: request.message,
      args: request.executeArgs,
      ...(request.previewDiff === undefined ? {} : { previewDiff: request.previewDiff }),
    });

    store.setPrompt({
      type: "select",
      message: "Approve this action?",
      options: { choices },
      resolve: (val: unknown) => {
        const choice = val as string;
        store.printOutput({
          type: "log",
          message: `Approve this action? ${CHALK_THEME.success(choice === "no" ? "No" : "Yes")}`,
          timestamp: new Date(),
        });

        if (choice === "yes") {
          store.setPrompt(null);
          store.setApprovalRequest(null);
          this.completeApproval(resume, { approved: true });
          return;
        }

        if (choice === "always_command" && approvalKey) {
          store.setPrompt(null);
          store.setApprovalRequest(null);
          this.completeApproval(resume, { approved: true, alwaysApproveCommand: approvalKey });
          return;
        }

        if (choice === "always_tool") {
          store.setPrompt(null);
          store.setApprovalRequest(null);
          this.completeApproval(resume, { approved: true, alwaysApproveTool: toolDisplayName });
          return;
        }

        // Rejected: prompt for optional message to guide the agent
        store.setPrompt(null);
        store.setApprovalRequest(null);
        this.promptRejectionMessage(resume);
      },
    });
  }

  /**
   * Show follow-up text prompt after a rejection to let the user guide the agent.
   */
  private promptRejectionMessage(
    resume: (effect: Effect.Effect<ApprovalOutcome, never>) => void,
  ): void {
    const followUpMessage = "What should the agent do instead? (optional — press Enter to skip)";
    store.setPrompt({
      type: "text",
      message: followUpMessage,
      options: {},
      resolve: (input: unknown) => {
        store.setPrompt(null);
        store.setApprovalRequest(null);
        const userMessage = typeof input === "string" ? input.trim() : "";
        if (userMessage) {
          echoUserTurn(userMessage);
        }
        this.completeApproval(
          resume,
          userMessage
            ? ({ approved: false, userMessage } as const)
            : ({ approved: false } as const),
        );
      },
    });
  }

  reportConnector(name: string, status: "live" | "renew" | "offline"): Effect.Effect<void, never> {
    return Effect.sync(() => {
      store.setConnector(name, status);
    });
  }

  /** Both interactive interfaces render an approval the user answers in place. */
  canPromptForApproval(): boolean {
    return true;
  }

  signalToolExecutionStarted(): Effect.Effect<void, never> {
    return Effect.sync(() => {
      // If there's a pending signal callback, invoke it to allow the next
      // approval prompt to appear. The tool executor now fires this AFTER the
      // tool completes and its result card has printed (not at start), so
      // approvals and results never interleave: approve → run → result →
      // approve. The method name is kept for interface compatibility.
      if (this.pendingExecutionSignal) {
        this.pendingExecutionSignal();
      }
    });
  }

  requestUserInput(request: UserInputRequest): Effect.Effect<UserInputOutcome, never> {
    return Effect.async((resume) => {
      // Add to queue and process
      this.userInputQueue.push({ request, resume });
      this.processNextUserInput();
    });
  }

  /**
   * Process the next user input request in the queue.
   */
  private processNextUserInput(): void {
    // If already processing or queue is empty, do nothing
    if (this.isProcessingUserInput || this.userInputQueue.length === 0) {
      return;
    }

    this.isProcessingUserInput = true;
    const { request, resume } = this.userInputQueue.shift()!;

    // Send system notification for user input request.
    if (this.notificationService) {
      Effect.runFork(
        this.notificationService
          .notify(`Agent is asking a question`, {
            title: "Jazz Input Required",
            sound: true,
          })
          .pipe(
            Effect.catchAll((error) => {
              console.error("[Notification] Failed to send user input notification:", error);
              return Effect.void;
            }),
          ),
      );
    }

    // Show the question with formatted suggestions
    const separator = chalk.dim(separatorLine(50));
    store.printOutput({
      type: "log",
      message: `\n${separator}`,
      timestamp: new Date(),
    });
    store.printOutput({
      type: "log",
      message: `${CHALK_THEME.primary("❓")} ${chalk.bold(request.question)}`,
      timestamp: new Date(),
    });
    store.printOutput({
      type: "log",
      message: separator,
      timestamp: new Date(),
    });

    // Set up questionnaire prompt
    store.setPrompt({
      type: "questionnaire",
      message: request.question,
      options: {
        suggestions: request.suggestions,
        allowCustom: request.allowCustom,
        allowMultiple: request.allowMultiple,
      },
      resolve: (value: unknown) => {
        const response = String(value).trim();
        echoUserTurn(response);
        store.setPrompt(null);
        store.setApprovalRequest(null);
        this.isProcessingUserInput = false;
        resume(
          Effect.succeed(
            response.length > 0 ? { kind: "answered", response } : { kind: "declined" },
          ),
        );
        this.processNextUserInput();
      },
      reject: () => {
        store.setPrompt(null);
        store.setApprovalRequest(null);
        this.isProcessingUserInput = false;
        resume(Effect.succeed({ kind: "declined" })); // Dismissed the prompt.
        this.processNextUserInput();
      },
    });
  }

  requestFilePicker(request: FilePickerRequest): Effect.Effect<string, never> {
    return Effect.async((resume) => {
      // Show the file picker prompt
      const separator = chalk.dim(separatorLine(50));
      store.printOutput({
        type: "log",
        message: `\n${separator}`,
        timestamp: new Date(),
      });
      store.printOutput({
        type: "log",
        message: `${CHALK_THEME.primary("📁")} ${chalk.bold(request.message)}`,
        timestamp: new Date(),
      });
      store.printOutput({
        type: "log",
        message: separator,
        timestamp: new Date(),
      });

      // Set up file picker prompt
      store.setPrompt({
        type: "filepicker",
        message: request.message,
        options: {
          basePath: request.basePath ?? process.cwd(),
          extensions: request.extensions,
          includeDirectories: request.includeDirectories,
        },
        resolve: (value: unknown) => {
          const selectedPath = String(value);
          const rawMsg = `${chalk.dim("Selected:")} ${CHALK_THEME.success(selectedPath)}`;
          store.printOutput({
            type: "log",
            message: rawMsg,
            timestamp: new Date(),
          });
          store.setPrompt(null);
          store.setApprovalRequest(null);
          resume(Effect.succeed(selectedPath));
        },
        reject: () => {
          store.setPrompt(null);
          store.setApprovalRequest(null);
          resume(Effect.succeed("")); // Return empty on cancel
        },
      });
    });
  }
}

export const InkPresentationServiceLayer = Layer.effect(
  PresentationServiceTag,
  Effect.gen(function* () {
    const configServiceOption = yield* Effect.serviceOption(AgentConfigServiceTag);
    const displayConfig = Option.isSome(configServiceOption)
      ? resolveDisplayConfig(yield* configServiceOption.value.appConfig)
      : DEFAULT_DISPLAY_CONFIG;

    // Get notification service if available
    const notificationServiceOption = yield* Effect.serviceOption(NotificationServiceTag);
    const notificationService = Option.isSome(notificationServiceOption)
      ? notificationServiceOption.value
      : null;

    return new InkPresentationService(displayConfig, notificationService);
  }),
);
