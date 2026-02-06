import chalk from "chalk";
import { Effect, Layer, Option } from "effect";
import { Box, Text } from "ink";
import React from "react";
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
import { getModelsDevMetadata } from "@/services/llm/models-dev-client";
import { CLIRenderer, type CLIRendererConfig } from "./cli-renderer";
import { formatMarkdown, formatMarkdownHybrid } from "./markdown-formatter";
import { applyTextChunkOrdered } from "./stream-text-order";
import { AgentResponseCard } from "../ui/AgentResponseCard";
import { store } from "../ui/App";
import { setLastExpandedDiff } from "../ui/diff-expansion-store";

function renderToolBadge(label: string): React.ReactElement {
  return React.createElement(
    Box,
    { borderStyle: "round", borderColor: "cyan", paddingX: 1 },
    React.createElement(Text, { color: "cyan" }, label),
  );
}

export class InkStreamingRenderer implements StreamingRenderer {
  private readonly activeTools = new Map<string, string>();
  private liveText: string = "";
  private reasoningBuffer: string = "";
  private completedReasoning: string = "";
  private isThinking: boolean = false;
  private lastAgentHeaderWritten: boolean = false;
  private lastRawText: string = "";
  private lastRawReasoning: string = "";
  private lastFormattedText: string = "";
  private lastFormattedReasoning: string = "";

  private lastUpdateTime: number = 0;
  private pendingUpdate: boolean = false;
  private updateTimeoutId: ReturnType<typeof setTimeout> | null = null;
  /** Ignore out-of-order text_chunk events when streaming delivers them reordered. */
  private lastAppliedTextSequence: number = -1;
  private static readonly UPDATE_THROTTLE_MS = 30;

  private static readonly MAX_REASONING_LENGTH = 8000;

  private toolTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private static readonly TOOL_WARNING_MS = 30_000; // 30 seconds

  // Store provider/model for cost calculation
  private currentProvider: string | null = null;
  private currentModel: string | null = null;

  constructor(
    private readonly agentName: string,
    private readonly showMetrics: boolean,
    private readonly displayConfig: DisplayConfig,
  ) {}

  reset(): Effect.Effect<void, never> {
    return Effect.sync(() => {
      this.activeTools.clear();
      this.liveText = "";
      this.reasoningBuffer = "";
      this.completedReasoning = "";
      this.isThinking = false;
      this.lastAgentHeaderWritten = false;
      this.lastRawText = "";
      this.lastRawReasoning = "";
      this.lastFormattedText = "";
      this.lastFormattedReasoning = "";
      this.lastAppliedTextSequence = -1;
      this.lastUpdateTime = 0;
      this.pendingUpdate = false;
      if (this.updateTimeoutId) {
        clearTimeout(this.updateTimeoutId);
        this.updateTimeoutId = null;
      }
      store.setStatus(null);
      store.setStream(null);
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
      this.pendingUpdate = false;

      if (this.liveText.trim().length > 0) {
        store.printOutput({ type: "log", message: this.liveText, timestamp: new Date() });
      }
      this.liveText = "";
      store.setStream(null);
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
      switch (event.type) {
        case "stream_start": {
          this.lastAgentHeaderWritten = true;
          // Store provider/model for cost calculation
          this.currentProvider = event.provider;
          this.currentModel = event.model;
          // Reset reasoning state for new stream
          this.reasoningBuffer = "";
          this.completedReasoning = "";
          this.lastRawReasoning = "";
          this.lastFormattedReasoning = "";
          store.printOutput({
            type: "info",
            message: `${this.agentName} (${event.provider}/${event.model})`,
            timestamp: new Date(),
          });
          store.printOutput({
            type: "log",
            message: chalk.dim("(Tip: Press Ctrl+I to stop generation)"),
            timestamp: new Date(),
          });
          return;
        }

        case "thinking_start": {
          this.reasoningBuffer = "";
          this.isThinking = true;
          // Don't clear completedReasoning here - accumulate reasoning sessions
          // Only clear on stream_start to handle multiple reasoning sessions
          this.updateLiveStream(false, true);
          return;
        }

        case "thinking_chunk": {
          this.reasoningBuffer += event.content;
          this.updateLiveStream();
          return;
        }

        case "thinking_complete": {
          this.isThinking = false;
          this.logReasoning();

          const newReasoning = this.reasoningBuffer.trim();
          if (newReasoning.length > 0) {
            if (this.completedReasoning.trim().length > 0) {
              this.completedReasoning += "\n\n---\n\n" + newReasoning;
            } else {
              this.completedReasoning = newReasoning;
            }
            // Cap reasoning to prevent unbounded growth and slow formatting
            if (this.completedReasoning.length > InkStreamingRenderer.MAX_REASONING_LENGTH) {
              // Keep the most recent reasoning, truncate older content
              const truncatePoint = this.completedReasoning.length - InkStreamingRenderer.MAX_REASONING_LENGTH;
              const nextSeparator = this.completedReasoning.indexOf("---", truncatePoint);
              if (nextSeparator > 0) {
                this.completedReasoning = "...(earlier reasoning truncated)...\n\n" +
                  this.completedReasoning.substring(nextSeparator);
              } else {
                this.completedReasoning = this.completedReasoning.substring(truncatePoint);
              }
            }
          }
          this.reasoningBuffer = "";
          // Update stream to include all accumulated reasoning
          this.updateLiveStream(true);
          return;
        }

        case "tools_detected": {
          const approvalSet = new Set(event.toolsRequiringApproval);
          const formattedTools = event.toolNames
            .map((name) => {
              if (approvalSet.has(name)) {
                return `${name} (requires approval)`;
              }
              return name;
            })
            .join(", ");
          store.printOutput({
            type: "info",
            message: ink(renderToolBadge(`Tools: ${formattedTools}`)),
            timestamp: new Date(),
          });
          return;
        }

        case "tool_call": {
          store.printOutput({
            type: "debug",
            message: `Tool call detected: ${event.toolCall.function.name}`,
            timestamp: new Date(),
          });
          return;
        }

        case "tool_execution_start": {
          this.activeTools.set(event.toolCallId, event.toolName);
          store.setStatus(this.formatToolStatus());
          const argsStr = CLIRenderer.formatToolArguments(event.toolName, event.arguments);

          // Add provider info for web_search
          let providerSuffix = "";
          if (event.toolName === "web_search") {
            const provider = event.metadata?.["provider"];
            if (typeof provider === "string") {
              providerSuffix = chalk.dim(` [${provider}]`);
            }
          }

          const message = argsStr
            ? `⚙️  Executing tool: ${event.toolName}${providerSuffix}${argsStr}`
            : `⚙️  Executing tool: ${event.toolName}${providerSuffix}`;
          store.printOutput({

            type: "log",
            message,
            timestamp: new Date(),
          });

          // Set timeout warning for long-running tools
          const timeoutId = setTimeout(() => {
            if (this.activeTools.has(event.toolCallId)) {
              store.printOutput({
                type: "warn",
                message: `⏱️ Tool ${event.toolName} is taking longer than expected...`,
                timestamp: new Date(),
              });
            }
          }, InkStreamingRenderer.TOOL_WARNING_MS);
          this.toolTimeouts.set(event.toolCallId, timeoutId);
          return;
        }

        case "tool_execution_complete": {
          // Clear timeout warning
          const timeoutId = this.toolTimeouts.get(event.toolCallId);
          if (timeoutId) {
            clearTimeout(timeoutId);
            this.toolTimeouts.delete(event.toolCallId);
          }

          const toolName = this.activeTools.get(event.toolCallId);
          this.activeTools.delete(event.toolCallId);

          // Get summary from event or generate from result (for diff display)
          let summary = event.summary?.trim();
          if (!summary && toolName && event.result) {
            summary = CLIRenderer.formatToolResult(toolName, event.result);
          }

          const namePrefix = toolName ? `${toolName} ` : "";
          const displayText = summary && summary.length > 0 ? summary : namePrefix + "done";

          if (toolName && event.result) {
            this.storeExpandableDiff(toolName, event.result);
          }

          // Check if summary has multi-line content (e.g., diff output)
          const hasMultiLine = displayText.includes("\n");

          if (hasMultiLine) {
            // Print the completion first, then the diff on separate lines
            store.printOutput({
              type: "success",
              message: `${namePrefix}done (${event.durationMs}ms)`,
              timestamp: new Date(),
            });
            store.printOutput({
              type: "log",
              message: displayText,
              timestamp: new Date(),
            });
          } else {
            store.printOutput({
              type: "success",
              message: `${displayText} (${event.durationMs}ms)`,
              timestamp: new Date(),
            });
          }

          store.setStatus(this.activeTools.size > 0 ? this.formatToolStatus() : null);
          return;
        }

        case "text_start": {
          this.liveText = "";
          this.lastAppliedTextSequence = -1;
          // Include reasoning when text starts - reasoning should persist during text streaming
          this.updateLiveStream(true);
          return;
        }

        case "text_chunk": {
          const next = applyTextChunkOrdered(
            { liveText: this.liveText, lastAppliedSequence: this.lastAppliedTextSequence },
            { sequence: event.sequence, accumulated: event.accumulated },
          );
          this.liveText = next.liveText;
          this.lastAppliedTextSequence = next.lastAppliedSequence;
          this.updateLiveStream();
          return;
        }

        case "usage_update": {
          return;
        }

        case "error": {
          store.printOutput({
            type: "error",
            message: `Error: ${event.error.message}`,
            timestamp: new Date(),
          });
          store.setStatus(null);
          store.setStream(null);
          store.setInterruptHandler(null);
          return;
        }

        case "complete": {
          // Note: Task completion notifications are sent by streaming-executor.ts
          // when the full agent run completes, not here (which fires for each LLM stream)

          // If streaming never started (fallback), we may still want to show the response.
          if (!this.lastAgentHeaderWritten) {
            store.printOutput({
              type: "info",
              message: this.agentName,
              timestamp: new Date(),
            });
          }

          const finalText =
            this.liveText.trim().length > 0
              ? this.liveText
              : event.response.content.trim().length > 0
                ? event.response.content
                : "";
          const formattedFinalText = this.formatMarkdown(finalText);

          if (formattedFinalText.length > 0) {
            store.printOutput({
              type: "log",
              message: ink(
                React.createElement(AgentResponseCard, {
                  agentName: this.agentName,
                  content: formattedFinalText,
                }),
              ),
              timestamp: new Date(),
            });
          }

          if (this.showMetrics && event.metrics) {
            const parts: string[] = [];
            if (event.metrics.firstTokenLatencyMs) {
              parts.push(`First token: ${event.metrics.firstTokenLatencyMs}ms`);
            }
            if (event.metrics.tokensPerSecond) {
              parts.push(`Speed: ${event.metrics.tokensPerSecond.toFixed(1)} tok/s`);
            }
            // Show detailed token breakdown
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

            // Calculate and display cost asynchronously
            if (usage && this.currentProvider && this.currentModel) {
              const provider = this.currentProvider;
              const model = this.currentModel;
              const promptTokens = usage.promptTokens;
              const completionTokens = usage.completionTokens;

              // Fire-and-forget: fetch pricing and display cost
              void getModelsDevMetadata(model, provider)
                .then((meta) => {
                  if (meta?.inputPricePerMillion !== undefined || meta?.outputPricePerMillion !== undefined) {
                    const inputPrice = meta.inputPricePerMillion ?? 0;
                    const outputPrice = meta.outputPricePerMillion ?? 0;
                    const inputCost = (promptTokens / 1_000_000) * inputPrice;
                    const outputCost = (completionTokens / 1_000_000) * outputPrice;
                    const totalCost = inputCost + outputCost;

                    // Format cost display
                    const formatCost = (cost: number): string => {
                      if (cost === 0) return "$0.00";
                      if (cost >= 0.01) return `$${cost.toFixed(2)}`;
                      if (cost >= 0.0001) return `$${cost.toFixed(4)}`;
                      return `$${cost.toExponential(2)}`;
                    };

                    store.printOutput({
                      type: "debug",
                      message: `[Cost: ${formatCost(inputCost)} input + ${formatCost(outputCost)} output = ${formatCost(totalCost)} total]`,
                      timestamp: new Date(),
                    });
                    store.printOutput({ type: "log", message: "", timestamp: new Date() });
                  }
                })
                .catch(() => {
                });
            } else {
              store.printOutput({ type: "log", message: "", timestamp: new Date() });
            }
          }

          store.setStatus(null);
          store.setStream(null);
          store.setInterruptHandler(null);
          this.liveText = "";
          this.reasoningBuffer = "";
          this.completedReasoning = "";
          this.lastRawText = "";
          this.lastRawReasoning = "";
          this.lastFormattedText = "";
          this.lastFormattedReasoning = "";
          return;
        }
      }
    }).pipe(Effect.catchAll(() => Effect.void));
  }

  private formatToolStatus(): string {
    const uniqueToolNames = Array.from(new Set(this.activeTools.values()));
    if (uniqueToolNames.length === 0) return "Working…";
    if (uniqueToolNames.length === 1) return `Running ${uniqueToolNames[0]}…`;
    return `Running ${uniqueToolNames.length} tools… (${uniqueToolNames.join(", ")})`;
  }

  private storeExpandableDiff(toolName: string, result: string): void {
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
        setLastExpandedDiff(fullDiff);
      }
    } catch {
      // Ignore parse errors
    }
  }

  private updateLiveStream(includeReasoning: boolean = true, force: boolean = false): void {
    const now = Date.now();
    const timeSinceLastUpdate = now - this.lastUpdateTime;

    // Throttle updates to reduce React re-renders
    // If we updated recently, schedule a pending update instead
    if (!force && timeSinceLastUpdate < InkStreamingRenderer.UPDATE_THROTTLE_MS) {
      if (!this.pendingUpdate) {
        this.pendingUpdate = true;
        const delay = InkStreamingRenderer.UPDATE_THROTTLE_MS - timeSinceLastUpdate;
        this.updateTimeoutId = setTimeout(() => {
          this.pendingUpdate = false;
          this.updateTimeoutId = null;
          this.updateLiveStream(includeReasoning, true);
        }, delay);
      }
      return;
    }

    this.lastUpdateTime = now;
    this.pendingUpdate = false;

    // Determine raw content to show
    const rawText = this.liveText;
    const reasoningToShow = this.reasoningBuffer.trim().length > 0
      ? this.reasoningBuffer
      : this.completedReasoning.trim().length > 0
        ? this.completedReasoning
        : "";
    const shouldShowReasoning = includeReasoning && reasoningToShow.length > 0;
    const rawReasoning = shouldShowReasoning ? reasoningToShow : "";

    // Compare raw content first before expensive formatting
    // This avoids running multiple regex passes when content hasn't changed
    const textChanged = rawText !== this.lastRawText;
    const reasoningChanged = rawReasoning !== this.lastRawReasoning;

    if (!textChanged && !reasoningChanged && !force) {
      // No change in raw content, skip update entirely
      return;
    }

    // Only format what actually changed
    let formattedText = this.lastFormattedText;
    let formattedReasoning = this.lastFormattedReasoning;

    if (textChanged) {
      formattedText = this.formatMarkdown(rawText);
      this.lastRawText = rawText;
      this.lastFormattedText = formattedText;
    }

    if (reasoningChanged) {
      formattedReasoning = rawReasoning.length > 0 ? this.formatMarkdown(rawReasoning) : "";
      this.lastRawReasoning = rawReasoning;
      this.lastFormattedReasoning = formattedReasoning;
    }

    // Update the stream with the formatted content
    store.setStream({
      agentName: this.agentName,
      text: formattedText,
      reasoning: formattedReasoning,
      isThinking: this.isThinking,
    });
  }

  private logReasoning(): void {
    const reasoning = this.reasoningBuffer.trim();
    if (reasoning.length === 0) {
      return;
    }
    const formattedReasoning = this.formatMarkdown(reasoning);

    const displayReasoning = chalk.gray(formattedReasoning);
    store.printOutput({
      type: "log",
      message: chalk.gray(`🧠 Reasoning:\n${displayReasoning}`),
      timestamp: new Date(),
    });
  }

  private formatMarkdown(text: string): string {
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
  private renderer: CLIRenderer | null = null;

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

  private getRenderer(): CLIRenderer {
    if (!this.renderer) {
      const config: CLIRendererConfig = {
        displayConfig: this.displayConfig,
        streamingConfig: {},
        showMetrics: false,
        agentName: "Agent",
      };
      this.renderer = new CLIRenderer(config);
    }
    return this.renderer;
  }

  presentThinking(agentName: string, isFirstIteration: boolean): Effect.Effect<void, never> {
    return Effect.sync(() => {
      // For Ink UI, we use the status bar for thinking indicator instead of logging
      // The streaming renderer handles this via thinking_start event, but for non-streaming
      // cases we set status here. This avoids duplicate "thinking" messages.
      const message = isFirstIteration ? "thinking…" : "processing results…";
      store.setStatus(`${agentName} is ${message}`);
    });
  }

  presentCompletion(agentName: string): Effect.Effect<void, never> {
    return Effect.gen(this, function* () {
      const msg = yield* this.getRenderer().formatCompletion(agentName);
      store.printOutput({ type: "info", message: msg, timestamp: new Date() });
    });
  }

  presentWarning(agentName: string, message: string): Effect.Effect<void, never> {
    return Effect.gen(this, function* () {
      const msg = yield* this.getRenderer().formatWarning(agentName, message);
      store.printOutput({ type: "warn", message: msg, timestamp: new Date() });
    });
  }

  presentAgentResponse(agentName: string, content: string): Effect.Effect<void, never> {
    return Effect.gen(this, function* () {
      const formatted = yield* this.getRenderer().formatAgentResponse(agentName, content);
      store.printOutput({
        type: "log", // 'log' type uses default coloring (white/reset) which allows ANSI codes to shine
        message: formatted,
        timestamp: new Date(),
      });
    });
  }

  renderMarkdown(markdown: string): Effect.Effect<string, never> {
    return this.getRenderer().renderMarkdown(markdown);
  }

  formatToolArguments(toolName: string, args?: Record<string, unknown>): string {
    return CLIRenderer.formatToolArguments(toolName, args);
  }

  formatToolResult(toolName: string, result: string): string {
    return CLIRenderer.formatToolResult(toolName, result);
  }

  formatToolExecutionStart(
    toolName: string,
    args?: Record<string, unknown>,
  ): Effect.Effect<string, never> {
    return Effect.sync(() => {
      const argsStr = this.formatToolArguments(toolName, args);
      return argsStr;
    }).pipe(
      Effect.flatMap((argsStr) => this.getRenderer().formatToolExecutionStart(toolName, argsStr)),
    );
  }

  formatToolExecutionComplete(
    summary: string | null,
    durationMs: number,
  ): Effect.Effect<string, never> {
    return this.getRenderer().formatToolExecutionComplete(summary, durationMs);
  }

  formatToolExecutionError(errorMessage: string, durationMs: number): Effect.Effect<string, never> {
    return this.getRenderer().formatToolExecutionError(errorMessage, durationMs);
  }

  formatToolsDetected(
    agentName: string,
    toolNames: readonly string[],
    toolsRequiringApproval: readonly string[],
  ): Effect.Effect<string, never> {
    return this.getRenderer().formatToolsDetected(agentName, toolNames, toolsRequiringApproval);
  }

  createStreamingRenderer(
    config: StreamingRendererConfig,
  ): Effect.Effect<StreamingRenderer, never> {
    return Effect.sync(() => {
      return new InkStreamingRenderer(
        config.agentName,
        config.showMetrics,
        config.displayConfig,
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

    // Send system notification for approval request
    if (this.notificationService) {
      Effect.runFork(
        this.notificationService.notify(
          `Agent needs approval for ${request.toolName}`,
          {
            title: "Jazz Approval Required",
            sound: true,
          },
        ).pipe(
          Effect.catchAll((error) => {
            console.error("[Notification] Failed to send approval notification:", error);
            return Effect.void;
          }),
        ),
      );
    }

    // Format the approval message
    const toolLabel = chalk.cyan(request.toolName);
    const separator = chalk.dim("─".repeat(50));
    const pendingCount = this.approvalQueue.length;
    const pendingIndicator = pendingCount > 0
      ? chalk.dim(` (${pendingCount} more pending)`)
      : "";

    // Show approval details in Ink UI
    store.printOutput({
      type: "log",
      message: `\n${separator}`,
      timestamp: new Date(),
    });
    store.printOutput({
      type: "log",
      message: `${chalk.yellow("⚠️  Approval Required")} for ${toolLabel}${pendingIndicator}\n`,
      timestamp: new Date(),
    });
    store.printOutput({
      type: "log",
      message: `${chalk.bold(request.message)}\n`,
      timestamp: new Date(),
    });
    store.printOutput({
      type: "log",
      message: separator,
      timestamp: new Date(),
    });

    // Store preview diff for Ctrl+O expansion
    if (request.previewDiff) {
      setLastExpandedDiff(request.previewDiff);
    }

    // Use confirm prompt (default to Yes for faster workflow)
    store.setPrompt({
      type: "confirm",
      message: "Approve this action?",
      options: { defaultValue: true },
      resolve: (val: unknown) => {
        const approved = val as boolean;
        store.printOutput({
          type: "log",
          message: `Approve this action? ${chalk.green(approved ? "Yes" : "No")}`,
          timestamp: new Date(),
        });

        if (approved) {
          store.setPrompt(null);
          this.completeApproval(resume, { approved: true });
          return;
        }

        // Rejected: prompt for optional message to guide the agent
        const followUpMessage =
          "What should the agent do instead? (optional — press Enter to skip)";
        store.setPrompt({
          type: "text",
          message: followUpMessage,
          options: {},
          resolve: (input: unknown) => {
            store.setPrompt(null);
            const userMessage = typeof input === "string" ? input.trim() : "";
            if (userMessage) {
              store.printOutput({
                type: "log",
                message: `${followUpMessage} ${chalk.green(userMessage)}`,
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

    // Show the question with formatted suggestions
    const separator = chalk.dim("─".repeat(50));
    store.printOutput({
      type: "log",
      message: `\n${separator}`,
      timestamp: new Date(),
    });
    store.printOutput({
      type: "log",
      message: `${chalk.cyan("❓")} ${chalk.bold(request.question)}`,
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
        store.printOutput({
          type: "log",
          message: `${chalk.dim("Your response:")} ${chalk.green(response)}`,
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
        message: `${chalk.cyan("📁")} ${chalk.bold(request.message)}`,
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
          store.printOutput({
            type: "log",
            message: `${chalk.dim("Selected:")} ${chalk.green(selectedPath)}`,
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
