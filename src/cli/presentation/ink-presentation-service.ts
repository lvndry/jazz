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
import {
  formatForTerminal,
  formatMarkdown,
  formatMarkdownHybrid,
  wrapToWidth,
  getTerminalWidth,
  padLines,
} from "./markdown-formatter";
import { AgentResponseCard } from "../ui/AgentResponseCard";
import { store } from "../ui/store";
import { CHALK_THEME, THEME } from "../ui/theme";

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
export class InkStreamingRenderer implements StreamingRenderer {
  private readonly acc;
  /** Timestamp of the last activity state push to the store. */
  private lastUpdateTime: number = 0;
  /** Most recent activity state waiting to be flushed by the throttle timer. */
  private pendingActivity: ActivityState | null = null;
  /** Timer handle for the throttled activity update. */
  private updateTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private readonly updateThrottleMs: number;

  private streamBuffer = "";
  private streamRaw = "";
  private streamFormatted = "";
  private lastPrintedLength = 0;
  private hasStreamedText = false;
  private reasoningBuffer = "";
  private reasoningRaw = "";
  private reasoningFormatted = "";
  private reasoningHeaderPrinted = false;

  private toolTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private static readonly TOOL_WARNING_MS = 30_000; // 30 seconds

  constructor(
    private readonly agentName: string,
    private readonly showMetrics: boolean,
    private readonly displayConfig: DisplayConfig,
    _streamingConfig?: { textBufferMs?: number },
    throttleMs?: number,
  ) {
    this.updateThrottleMs = throttleMs ?? 100;
    this.acc = createAccumulator(agentName);
  }

  reset(): Effect.Effect<void, never> {
    return Effect.sync(() => {
      this.acc.activeTools.clear();
      this.acc.liveText = "";
      this.acc.reasoningBuffer = "";
      this.acc.completedReasoning = "";
      this.acc.isThinking = false;
      this.acc.lastAgentHeaderWritten = false;
      this.acc.lastAppliedTextSequence = -1;
      this.acc._cachedReasoningInput = "";
      this.acc._cachedReasoningOutput = "";
      this.resetStreamingState();
      this.resetReasoningState();
      this.lastUpdateTime = 0;
      this.pendingActivity = null;
      if (this.updateTimeoutId) {
        clearTimeout(this.updateTimeoutId);
        this.updateTimeoutId = null;
      }
      this.clearAllToolTimeouts();
      store.setActivity({ phase: "idle" });
      store.setInterruptHandler(null);
    });
  }

  flush(): Effect.Effect<void, never> {
    return Effect.sync(() => {
      // Clear any pending throttled update
      if (this.updateTimeoutId) {
        clearTimeout(this.updateTimeoutId);
        this.updateTimeoutId = null;
      }
      this.pendingActivity = null;
      this.clearAllToolTimeouts();

      // Flush any buffered streaming text to output
      this.flushStreamingBuffer(true);
      this.flushReasoningBuffer(true);
      this.acc.liveText = "";
      store.setActivity({ phase: "idle" });
      store.setInterruptHandler(null);
    });
  }

  setInterruptHandler(handler: (() => void) | null): Effect.Effect<void, never> {
    return Effect.sync(() => {
      store.setInterruptHandler(handler);
    });
  }

  handleEvent(event: StreamEvent): Effect.Effect<void, never> {
    return Effect.sync(() => {
      if (event.type === "stream_start") {
        this.resetStreamingState();
        this.resetReasoningState();
      }

      if (this.displayConfig.showThinking) {
        if (event.type === "thinking_start") {
          this.startReasoningStream();
        }
        if (event.type === "thinking_chunk") {
          this.appendReasoningText(event.content);
        }
        if (event.type === "thinking_complete") {
          this.flushReasoningBuffer(true);
        }
      }

      // Handle "complete" specially — it has async cost-calculation + response card rendering
      if (event.type === "complete") {
        this.handleComplete(event);
        return;
      }

      // Handle tool_execution_start/complete — need timeout management
      if (event.type === "tool_execution_start") {
        if (!event.longRunning) {
          this.setupToolTimeout(event.toolCallId, event.toolName);
        }
      }
      if (event.type === "tool_execution_complete") {
        this.clearToolTimeout(event.toolCallId);
        this.storeExpandableDiff(
          this.acc.activeTools.get(event.toolCallId)?.toolName,
          event.result,
        );
      }

      // Run the pure reducer.
      // Reasoning text uses a narrower pre-wrap width to match its display
      // container (thinking Box paddingX=2 + reasoning Box paddingLeft=1 = 5
      // extra on top of App paddingX=3, total 11 chars of horizontal padding).
      const result = reduceEvent(this.acc, event, (text) => this.formatReasoningText(text), ink);

      // Flush output side-effects immediately
      for (const entry of result.outputs) {
        store.printOutput(entry);
      }

      if (event.type === "text_start") {
        this.resetStreamingState();
      }

      if (event.type === "text_chunk") {
        const delta = this.getStreamingDelta(event);
        if (delta.length > 0) {
          this.appendStreamingText(delta);
        }
      }

      // Throttle high-frequency activity updates (streaming text / thinking).
      // Tool execution and other infrequent events are set immediately so the
      // spinner appears without delay after tool-call approval.
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
    // Cancel any pending throttled activity update so it doesn't fire after we clear
    if (this.updateTimeoutId) {
      clearTimeout(this.updateTimeoutId);
      this.updateTimeoutId = null;
      this.pendingActivity = null;
    }

    this.flushStreamingBuffer(true);
    this.flushReasoningBuffer(true);
    if (!this.hasStreamedText) {
      this.printFinalResponse(event);
    }

    if (this.showMetrics && event.metrics) {
      this.printMetrics(event);
      this.printCost(event);
    }

    // Clear the live area AFTER Static content is committed, so the user never
    // sees a blank frame where the streamed content has disappeared.
    // Keep the interrupt handler registered here; intermediate completions
    // (e.g. tool-call iterations) should remain interruptible.
    store.setActivity({ phase: "idle" });

    this.acc.liveText = "";
    this.acc.reasoningBuffer = "";
    this.acc.completedReasoning = "";
    this.resetStreamingState();
    this.resetReasoningState();
  }

  /**
   * Print the full response text to Static as a single entry.
   *
   * Prefer event.response.content when no streamed text was emitted.
   * During streaming we append chunks directly to output, so liveText may be
   * empty or partial and should not be used to re-print the response.
   */
  private printFinalResponse(event: Extract<StreamEvent, { type: "complete" }>): void {
    const wasStreaming = this.acc.lastAgentHeaderWritten;
    const fullContent = event.response.content?.trim() ?? "";
    const liveContent = this.acc.liveText.trim();
    const finalText =
      fullContent.length > 0 ? fullContent : liveContent.length > 0 ? liveContent : "";
    const formattedFull = this.formatMarkdown(finalText);

    if (formattedFull.length === 0) return;

    if (wasStreaming) {
      // Print the full formatted response as a single Static entry.
      store.printOutput({
        type: "streamContent",
        message: padLines(formattedFull, 2),
        timestamp: new Date(),
      });
    } else {
      // Non-streaming fallback: show the full response card since nothing was
      // displayed in the live area.
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

  private resetStreamingState(): void {
    this.streamBuffer = "";
    this.streamRaw = "";
    this.streamFormatted = "";
    this.lastPrintedLength = 0;
    this.hasStreamedText = false;
  }

  private resetReasoningState(): void {
    this.reasoningBuffer = "";
    this.reasoningRaw = "";
    this.reasoningFormatted = "";
    this.reasoningHeaderPrinted = false;
  }

  private getStreamingDelta(event: Extract<StreamEvent, { type: "text_chunk" }>): string {
    // Only stream for the chunk that was actually applied by the reducer.
    if (event.sequence !== this.acc.lastAppliedTextSequence) {
      return "";
    }

    // Use accumulated text length (not bounded liveText length) so front-trimming
    // does not break incremental output.
    const nextText = event.accumulated;
    if (nextText.length <= this.lastPrintedLength) {
      return "";
    }

    const delta = nextText.slice(this.lastPrintedLength);
    this.lastPrintedLength = nextText.length;
    return delta;
  }

  private appendStreamingText(delta: string): void {
    if (!delta) return;
    this.streamBuffer += delta;

    let flushText = "";
    const lastNewline = this.streamBuffer.lastIndexOf("\n");
    if (lastNewline !== -1) {
      flushText += this.streamBuffer.slice(0, lastNewline + 1);
      this.streamBuffer = this.streamBuffer.slice(lastNewline + 1);
    }

    if (flushText.length > 0) {
      this.emitStreamText(flushText);
    }
  }

  private startReasoningStream(): void {
    if (this.reasoningHeaderPrinted) return;
    const header = chalk.dim(chalk.italic("▸ Reasoning"));
    store.printOutput({
      type: "streamContent",
      message: formatForTerminal(header, { padding: 2 }),
      timestamp: new Date(),
    });
    this.reasoningHeaderPrinted = true;
  }

  private appendReasoningText(delta: string): void {
    if (!delta) return;
    this.reasoningBuffer += delta;

    let flushText = "";
    const lastNewline = this.reasoningBuffer.lastIndexOf("\n");
    if (lastNewline !== -1) {
      flushText += this.reasoningBuffer.slice(0, lastNewline + 1);
      this.reasoningBuffer = this.reasoningBuffer.slice(lastNewline + 1);
    }

    if (flushText.length > 0) {
      this.emitReasoningText(flushText);
    }
  }

  private flushStreamingBuffer(force: boolean): void {
    if (force && this.streamBuffer.length > 0) {
      this.emitStreamText(this.streamBuffer);
      this.streamBuffer = "";
    }
  }

  private flushReasoningBuffer(force: boolean): void {
    if (force && this.reasoningBuffer.length > 0) {
      this.emitReasoningText(this.reasoningBuffer);
      this.reasoningBuffer = "";
    }
  }

  private emitStreamText(text: string): void {
    const formattedDelta = this.formatStreamingDelta(text);
    if (formattedDelta.length === 0) return;
    const padding = 4;
    // Match Ink layout: App paddingX=3 (6 total) + baked left padding.
    store.printOutput({
      type: "streamContent",
      message: formatForTerminal(formattedDelta, {
        padding,
        availableWidth: getTerminalWidth() - (6 + padding),
      }),
      timestamp: new Date(),
    });
    this.hasStreamedText = true;
  }

  private emitReasoningText(text: string): void {
    if (!text) return;
    const formattedDelta = this.formatReasoningDelta(text);
    if (formattedDelta.length === 0) return;
    const padding = 4;
    // Match Ink layout: App paddingX=3 (6 total) + baked left padding.
    store.printOutput({
      type: "streamContent",
      message: formatForTerminal(chalk.dim(formattedDelta), {
        padding,
        availableWidth: getTerminalWidth() - (6 + padding),
      }),
      timestamp: new Date(),
    });
  }

  private getFormattedDelta(previous: string, next: string): string {
    if (next.startsWith(previous)) {
      return next.slice(previous.length);
    }
    // Fallback for rare non-prefix transitions (e.g. formatter reinterpretation).
    // Emit only the changed suffix to minimize duplication in append-only output.
    let commonPrefixLength = 0;
    const maxPrefixLength = Math.min(previous.length, next.length);
    while (
      commonPrefixLength < maxPrefixLength &&
      previous.charCodeAt(commonPrefixLength) === next.charCodeAt(commonPrefixLength)
    ) {
      commonPrefixLength += 1;
    }
    return next.slice(commonPrefixLength);
  }

  private formatStreamingAccumulated(text: string): string {
    if (this.displayConfig.mode === "rendered") {
      return formatMarkdown(text);
    }
    if (this.displayConfig.mode === "hybrid") {
      return formatMarkdownHybrid(text);
    }
    return text;
  }

  private formatReasoningAccumulated(text: string): string {
    if (this.displayConfig.mode === "rendered") {
      return formatMarkdown(text);
    }
    if (this.displayConfig.mode === "hybrid") {
      return formatMarkdownHybrid(text);
    }
    return text;
  }

  private formatStreamingDelta(text: string): string {
    this.streamRaw += text;
    const nextFormatted = this.formatStreamingAccumulated(this.streamRaw);
    const delta = this.getFormattedDelta(this.streamFormatted, nextFormatted);
    this.streamFormatted = nextFormatted;
    return delta;
  }

  private formatReasoningDelta(text: string): string {
    this.reasoningRaw += text;
    const nextFormatted = this.formatReasoningAccumulated(this.reasoningRaw);
    const delta = this.getFormattedDelta(this.reasoningFormatted, nextFormatted);
    this.reasoningFormatted = nextFormatted;
    return delta;
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
      store.printOutput({ type: "log", message: "", timestamp: new Date() });
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
      }
      store.printOutput({ type: "log", message: "", timestamp: new Date() });
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
          store.printOutput({ type: "log", message: "", timestamp: new Date() });
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
      const obj = parsed as Record<string, unknown>;
      const fullDiff = obj["fullDiff"];
      const wasTruncated = obj["wasTruncated"];
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

  /**
   * Format markdown and pre-wrap at terminal width for streaming response text.
   *
   * Pre-wrapping ensures correct line breaks regardless of Ink/Yoga's width.
   * Streaming response text renders inside App paddingX=3 (6 chars) with
   * padLines(2) applied downstream = 8 chars total horizontal padding.
   *
   * Always uses stateless formatting — same code path for streaming and completion.
   */
  private formatMarkdown(text: string): string {
    // Pre-wrap to bypass Ink/Yoga layout bugs with live area text wrapping.
    // 8 = App paddingX=3 (6) + padLines(2) baked in downstream.
    return this.formatMarkdownAtWidth(text, getTerminalWidth() - 8);
  }

  /**
   * Format markdown and pre-wrap at terminal width for reasoning text.
   *
   * Reasoning is displayed in the thinking-phase Box hierarchy:
   *   App paddingX=3 (6) + thinking Box paddingX=2 (4) + reasoning Box paddingLeft=1 (1) = 11
   * Using the correct width prevents Ink from double-wrapping pre-wrapped lines.
   */
  private formatReasoningText(text: string): string {
    // 11 = App(6) + thinking paddingX=2(4) + reasoning paddingLeft=1(1)
    return this.formatMarkdownAtWidth(text, getTerminalWidth() - 11);
  }

  private formatMarkdownAtWidth(text: string, availableWidth: number): string {
    let formatted: string;
    if (this.displayConfig.mode === "rendered") {
      formatted = formatMarkdown(text);
    } else if (this.displayConfig.mode === "hybrid") {
      formatted = formatMarkdownHybrid(text);
    } else {
      formatted = text;
    }
    return wrapToWidth(formatted, availableWidth);
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

  /** Format markdown using the display mode from config, pre-wrapped to terminal width. */
  private formatMarkdownText(text: string): string {
    let formatted: string;
    if (this.displayConfig.mode === "rendered") {
      formatted = formatMarkdown(text);
    } else if (this.displayConfig.mode === "hybrid") {
      formatted = formatMarkdownHybrid(text);
    } else {
      formatted = text;
    }
    const available = getTerminalWidth() - 12;
    return wrapToWidth(formatted, available);
  }

  presentThinking(agentName: string, _isFirstIteration: boolean): Effect.Effect<void, never> {
    return Effect.sync(() => {
      store.setActivity({
        phase: "thinking",
        agentName,
        reasoning: "",
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
      const header = CHALK_THEME.primaryBold(`🤖 ${agentName}:`);
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
  ): Effect.Effect<string, never> {
    return formatToolExecutionStartEffect(toolName, this.formatToolArguments(toolName, args));
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
        paddingX: 2,
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
            message: wrapToWidth(rawMsg, getTerminalWidth() - 8),
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
      message: wrapToWidth(
        `${CHALK_THEME.primary("❓")} ${chalk.bold(request.question)}`,
        getTerminalWidth() - 8,
      ),
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
        const available = getTerminalWidth() - 8;
        store.printOutput({
          type: "log",
          message: wrapToWidth(rawMessage, available),
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
            message: wrapToWidth(rawMsg, getTerminalWidth() - 8),
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
