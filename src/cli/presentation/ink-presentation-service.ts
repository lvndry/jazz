import chalk from "chalk";
import { Effect, Layer, Option } from "effect";
import { Box, Text } from "ink";
import React from "react";
import { DEFAULT_DISPLAY_CONFIG } from "@/core/agent/types";
import { AgentConfigServiceTag } from "@/core/interfaces/agent-config";
import type {
  PresentationService,
  StreamingRenderer,
  StreamingRendererConfig,
} from "@/core/interfaces/presentation";
import { PresentationServiceTag } from "@/core/interfaces/presentation";
import { ink } from "@/core/interfaces/terminal";
import type { DisplayConfig } from "@/core/types/output";
import type { StreamEvent } from "@/core/types/streaming";
import type { ApprovalRequest, ApprovalOutcome } from "@/core/types/tools";
import { resolveDisplayConfig } from "@/core/utils/display-config";
import { CLIRenderer, type CLIRendererConfig } from "./cli-renderer";
import { formatMarkdown } from "./markdown-formatter";
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
          // Don't clear completedReasoning here - accumulate reasoning sessions
          // Only clear on stream_start to handle multiple reasoning sessions
          this.updateLiveStream(false);
          store.setStatus(`${this.agentName} is thinking…`);
          return;
        }

        case "thinking_chunk": {
          this.reasoningBuffer += event.content;
          this.updateLiveStream();
          return;
        }

        case "thinking_complete": {
          // Keep status if tools are running; otherwise clear.
          if (this.activeTools.size === 0) {
            store.setStatus(null);
          }
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
          const message = argsStr
            ? `⚙️  Executing tool: ${event.toolName}${argsStr}`
            : `⚙️  Executing tool: ${event.toolName}`;
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
            if (event.metrics.totalTokens) {
              parts.push(`Total: ${event.metrics.totalTokens} tokens`);
            }
            if (parts.length > 0) {
              store.printOutput({
                type: "debug",
                message: `[${parts.join(" | ")}]`,
                timestamp: new Date(),
              });
            }
            store.printOutput({ type: "log", message: "", timestamp: new Date() });
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

    if (!textChanged && !reasoningChanged) {
      // No change in raw content, skip formatting entirely
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
    });
  }

  private logReasoning(): void {
    const reasoning = this.reasoningBuffer.trim();
    if (reasoning.length === 0) {
      return;
    }
    const formattedReasoning = this.formatMarkdown(reasoning);
    const displayReasoning =
      this.displayConfig.mode === "markdown" ? chalk.gray(formattedReasoning) : formattedReasoning;
    store.printOutput({
      type: "log",
      message: `🧠 Reasoning:\n${displayReasoning}`,
      timestamp: new Date(),
    });
  }

  private formatMarkdown(text: string): string {
    if (this.displayConfig.mode === "markdown") {
      return formatMarkdown(text);
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

  constructor(private readonly displayConfig: DisplayConfig) {}

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
      return new InkStreamingRenderer(config.agentName, config.showMetrics, config.displayConfig);
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
   * Resumes the approval effect with the given outcome and runs cleanup:
   * clears processing flag and processes the next queued approval.
   */
  private completeApproval(
    resume: (effect: Effect.Effect<ApprovalOutcome, never>) => void,
    outcome: ApprovalOutcome,
  ): void {
    resume(Effect.succeed(outcome));
    this.isProcessingApproval = false;
    this.processNextApproval();
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
      message: `${request.message}\n`,
      timestamp: new Date(),
    });
    store.printOutput({
      type: "log",
      message: separator,
      timestamp: new Date(),
    });

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
}

export const InkPresentationServiceLayer = Layer.effect(
  PresentationServiceTag,
  Effect.gen(function* () {
    const configServiceOption = yield* Effect.serviceOption(AgentConfigServiceTag);
    const displayConfig = Option.isSome(configServiceOption)
      ? resolveDisplayConfig(yield* configServiceOption.value.appConfig)
      : DEFAULT_DISPLAY_CONFIG;
    return new InkPresentationService(displayConfig);
  }),
);
