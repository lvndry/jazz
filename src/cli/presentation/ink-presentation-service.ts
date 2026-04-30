import chalk from "chalk";
import { Effect, Layer, Option } from "effect";
import { Box, Text } from "ink";
import React from "react";
import type { ActivityState } from "@/cli/ui/activity-state";
import { DEFAULT_DISPLAY_CONFIG } from "@/core/agent/types";
import { AgentConfigServiceTag } from "@/core/interfaces/agent-config";
import { NotificationServiceTag, type NotificationService } from "@/core/interfaces/notification";
import type {
  FilePickerRequest,
  PresentationService,
  StreamingRenderer,
  StreamingRendererConfig,
  StreamTarget,
  UserInputRequest,
} from "@/core/interfaces/presentation";
import { PresentationServiceTag } from "@/core/interfaces/presentation";
import { ink } from "@/core/interfaces/terminal";
import type { DisplayConfig } from "@/core/types/output";
import type { StreamEvent } from "@/core/types/streaming";
import type { ApprovalRequest, ApprovalOutcome } from "@/core/types/tools";
import { resolveDisplayConfig } from "@/core/utils/display-config";
import { getModelsDevMetadata, getModelsDevMetadataSync } from "@/core/utils/models-dev-client";
import { extractCommandApprovalKey } from "@/core/utils/shell-utils";
import { createAccumulator, reduceEvent } from "./activity-reducer";
import {
  formatToolArguments,
  formatToolResult,
  formatCompletion,
  formatWarning,
  formatToolExecutionStartEffect,
  formatToolExecutionCompleteEffect,
  formatToolExecutionErrorEffect,
  formatToolsDetectedEffect,
} from "./format-utils";
import { formatMarkdown, formatMarkdownHybrid } from "./markdown-formatter";
import { AgentResponseCard } from "../ui/AgentResponseCard";
import { store } from "../ui/store";
import { CHALK_THEME, PADDING, THEME } from "../ui/theme";

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
  private static readonly REASONING_PANEL_LINES = 8;

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

    this.streamBuffer.push(entry);
    if (this.streamFlushTimeoutId !== null) return;

    this.streamFlushTimeoutId = setTimeout(() => {
      this.streamFlushTimeoutId = null;
      this.flushStreamBuffer();
    }, this.textBufferMs);
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
        run = { ...run, delta: run.delta + entry.delta } as BufferedStreamDelta;
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
      // Flush buffered deltas BEFORE collapsing the reasoning region so any
      // in-flight reasoning text lands in the panel before it collapses.
      this.flushStreamBuffer();
      this.collapseReasoningRegion();
      store.finalizeStream();
      store.setActivity({ phase: "idle" });
      store.setInterruptHandler(null);
    });
  }

  setInterruptHandler(handler: (() => void) | null): Effect.Effect<void, never> {
    return Effect.sync(() => {
      store.setInterruptHandler(handler);
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
    const line = chalk.dim(chalk.italic(`✓ Reasoning · ${seconds}s${tokenSegment}`));

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
      }

      if (this.displayConfig.showThinking) {
        if (event.type === "thinking_start") {
          if (this.streamTarget.kind === "ephemeral") {
            // Subagent reasoning lives in the subagent's own panel — no
            // separate reasoning region.
          } else if (this.reasoningRegionId === null) {
            this.reasoningRegionId = store.openEphemeral(
              "reasoning",
              "Reasoning",
              InkStreamingRenderer.REASONING_PANEL_LINES,
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
                InkStreamingRenderer.REASONING_PANEL_LINES,
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
      if (event.type === "tool_execution_complete") {
        this.clearToolTimeout(event.toolCallId);
        this.storeExpandableDiff(
          this.acc.activeTools.get(event.toolCallId)?.toolName,
          event.result,
        );
      }

      // Run the pure reducer for activity state + Static side-effects.
      const result = reduceEvent(this.acc, event, ink);

      for (const entry of result.outputs) {
        store.printOutput(entry);
      }

      if (event.type === "text_start") {
        // Reasoning was finalized by thinking_complete (or there was none).
        // Reset stream-text bookkeeping for the new response stream.
        this.seenLength = 0;
        this.hasStreamedText = false;
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

    if (!this.hasStreamedText) {
      this.printFinalResponse(event);
    }

    if (this.showMetrics && event.metrics) {
      store.printOutput({ type: "log", message: "", timestamp: new Date() });
      this.printMetrics(event);
      this.printCost(event);
    }

    store.setActivity({ phase: "idle" });
    // Defensive reset so a reused renderer instance starts clean even if no
    // text_start fires before the next text_chunk.
    this.seenLength = 0;
    this.hasStreamedText = false;
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
        timestamp: new Date(),
      });
    }
  }

  /** Print token usage metrics. */
  private printMetrics(event: Extract<StreamEvent, { type: "complete" }>): void {
    if (!event.metrics) return;

    const parts: string[] = [];
    if (event.metrics.firstTokenLatencyMs) {
      parts.push(`First token: ${event.metrics.firstTokenLatencyMs}ms`);
    }
    if (event.metrics.tokensPerSecond) {
      parts.push(`Speed: ${event.metrics.tokensPerSecond.toFixed(1)} tok/s`);
    }
    const usage = event.response.usage;
    if (usage) {
      parts.push(`Input: ${usage.promptTokens}`);
      parts.push(`Output: ${usage.completionTokens}`);
      if (usage.reasoningTokens !== undefined && usage.reasoningTokens > 0) {
        parts.push(`Reasoning: ${usage.reasoningTokens}`);
      }
      parts.push(`Total: ${usage.totalTokens} tokens`);
      // Push the prompt-side count to the persistent footer so users have
      // visibility on context-window pressure between turns.
      this.acc.lastPromptTokens = usage.promptTokens;
      store.updateRunStats({ tokensInContext: usage.promptTokens });
    } else if (event.metrics.totalTokens) {
      parts.push(`Total: ${event.metrics.totalTokens} tokens`);
    }
    if (parts.length > 0) {
      store.printOutput({
        type: "debug",
        message: `[${parts.join(" | ")}]`,
        timestamp: new Date(),
      });
    }
  }

  /**
   * Calculate and display cost. Uses synchronous cache lookup when possible
   * to avoid the cost line popping in after the prompt. Falls back to async
   * fetch on first run before the cache is warm.
   */
  private printCost(event: Extract<StreamEvent, { type: "complete" }>): void {
    const usage = event.response.usage;
    if (!usage || !this.acc.currentProvider || !this.acc.currentModel) {
      return;
    }

    const provider = this.acc.currentProvider;
    const model = this.acc.currentModel;
    const promptTokens = usage.promptTokens;
    const completionTokens = usage.completionTokens;

    const emitCost = (
      meta: { inputPricePerMillion?: number; outputPricePerMillion?: number } | undefined,
    ): void => {
      if (meta?.inputPricePerMillion !== undefined || meta?.outputPricePerMillion !== undefined) {
        const inputPrice = meta.inputPricePerMillion ?? 0;
        const outputPrice = meta.outputPricePerMillion ?? 0;
        const inputCost = (promptTokens / 1_000_000) * inputPrice;
        const outputCost = (completionTokens / 1_000_000) * outputPrice;
        const totalCost = inputCost + outputCost;

        const fmt = (cost: number): string => {
          if (cost === 0) return "$0.00";
          if (cost >= 0.01) return `$${cost.toFixed(2)}`;
          if (cost >= 0.0001) return `$${cost.toFixed(4)}`;
          return `$${cost.toExponential(2)}`;
        };

        store.printOutput({
          type: "debug",
          message: `[Cost: ${fmt(inputCost)} input + ${fmt(outputCost)} output = ${fmt(totalCost)} total]`,
          timestamp: new Date(),
        });

        // Roll session-cumulative cost into the persistent footer.
        this.acc.cumulativeCostUSD += totalCost;
        store.updateRunStats({
          model,
          provider,
          costUSD: this.acc.cumulativeCostUSD,
        });
      }
    };

    // Try synchronous cache hit first to avoid async print-after-prompt
    const cachedMeta = getModelsDevMetadataSync(model, provider);
    if (cachedMeta !== undefined) {
      emitCost(cachedMeta);
    } else {
      // Fallback: async fetch (first run before cache is warm)
      void getModelsDevMetadata(model, provider)
        .then(emitCost)
        .catch(() => {
          /* pricing unavailable — omit cost line */
        });
    }
  }

  private setupToolTimeout(toolCallId: string, toolName: string): void {
    const timeoutId = setTimeout(() => {
      if (this.acc.activeTools.has(toolCallId)) {
        store.printOutput({
          type: "warn",
          message: `⏱️ Tool ${toolName} is taking longer than expected...`,
          timestamp: new Date(),
        });
      }
    }, InkStreamingRenderer.TOOL_WARNING_MS);
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
    if (toolName !== "execute_edit_file" && toolName !== "execute_write_file") {
      return;
    }
    try {
      const parsed: unknown = JSON.parse(result);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return;
      }
      const parsedResult = parsed as Record<string, unknown>;
      const fullDiff = parsedResult["fullDiff"];
      const wasTruncated = parsedResult["wasTruncated"];
      if (typeof fullDiff === "string" && fullDiff.length > 0 && wasTruncated === true) {
        store.setExpandableDiff(fullDiff);
      }
    } catch {
      // Ignore parse errors
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
  resume: (effect: Effect.Effect<string, never>) => void;
}

/**
 * Ink implementation of PresentationService.
 *
 * Critical: does NOT write to stdout directly (which would clobber Ink rendering).
 * Instead, it pushes output into the Ink store.
 */
class InkPresentationService implements PresentationService {
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
  ) {}

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

  presentCompletion(agentName: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      store.printOutput({
        type: "info",
        message: formatCompletion(agentName),
        timestamp: new Date(),
      });
    });
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
      const header = CHALK_THEME.primaryBold(`◉ ${agentName}:`);
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
      toolName,
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
      const icons: Record<typeof level, { icon: string; color: string }> = {
        info: { icon: "ℹ", color: "blue" },
        success: { icon: "✓", color: "green" },
        warning: { icon: "⚠", color: "yellow" },
        error: { icon: "✗", color: "red" },
        progress: { icon: "⏳", color: "cyan" },
      };
      const { icon, color } = icons[level];
      const colorFn = chalk[color as keyof typeof chalk] as (s: string) => string;
      const formatted = `${colorFn(icon)} ${message}`;
      const type = level === "error" ? "error" : level === "warning" ? "warn" : "info";
      store.printOutput({ type, message: formatted, timestamp: new Date() });
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

    const approvalCard = React.createElement(
      Box,
      {
        flexDirection: "column",
        borderStyle: "round",
        borderColor: "yellow",
        paddingX: PADDING.content,
        paddingY: 1,
        marginTop: 1,
      },
      React.createElement(
        Box,
        {},
        React.createElement(Text, { color: "yellow", bold: true }, "Approval Required"),
        React.createElement(Text, {}, " for "),
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
          this.completeApproval(resume, { approved: true });
          return;
        }

        if (choice === "always_command" && approvalKey) {
          store.setPrompt(null);
          this.completeApproval(resume, { approved: true, alwaysApproveCommand: approvalKey });
          return;
        }

        if (choice === "always_tool") {
          store.setPrompt(null);
          this.completeApproval(resume, { approved: true, alwaysApproveTool: toolDisplayName });
          return;
        }

        // Rejected: prompt for optional message to guide the agent
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
        const userMessage = typeof input === "string" ? input.trim() : "";
        if (userMessage) {
          const rawMsg = `${followUpMessage} ${CHALK_THEME.success(userMessage)}`;
          store.printOutput({
            type: "log",
            message: rawMsg,
            timestamp: new Date(),
          });
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

  signalToolExecutionStarted(): Effect.Effect<void, never> {
    return Effect.sync(() => {
      // If there's a pending signal callback, invoke it to allow next approval
      if (this.pendingExecutionSignal) {
        this.pendingExecutionSignal();
      }
    });
  }

  requestUserInput(request: UserInputRequest): Effect.Effect<string, never> {
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
    const separator = chalk.dim("─".repeat(50));
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
        const response = String(value);
        const rawMessage = `${chalk.dim("Your response:")} ${CHALK_THEME.success(response)}`;
        store.printOutput({
          type: "log",
          message: rawMessage,
          timestamp: new Date(),
        });
        store.setPrompt(null);
        this.isProcessingUserInput = false;
        resume(Effect.succeed(response));
        this.processNextUserInput();
      },
      reject: () => {
        store.setPrompt(null);
        this.isProcessingUserInput = false;
        resume(Effect.succeed("")); // Return empty on cancel
        this.processNextUserInput();
      },
    });
  }

  requestFilePicker(request: FilePickerRequest): Effect.Effect<string, never> {
    return Effect.async((resume) => {
      // Show the file picker prompt
      const separator = chalk.dim("─".repeat(50));
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
          resume(Effect.succeed(selectedPath));
        },
        reject: () => {
          store.setPrompt(null);
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
