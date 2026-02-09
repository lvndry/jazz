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
import { getModelsDevMetadata, getModelsDevMetadataSync } from "@/core/utils/models-dev-client";
import { createAccumulator, reduceEvent } from "./activity-reducer";
import { CLIRenderer, type CLIRendererConfig } from "./cli-renderer";
import { formatMarkdown, formatMarkdownHybrid } from "./markdown-formatter";
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
 * **Live-area flushing**: When the reducer flushes paragraphs from the live
 * area to Static (via output entries on text_chunk), this renderer bypasses
 * the throttle for that update so the live area shrinks in the same frame
 * the Static content appears — preventing brief duplication.
 *
 * **Completion**: On `complete`, the unflushed tail of `liveText` (not the
 * full accumulation) is printed to Static, since earlier portions were
 * already flushed during streaming.
 */
export class InkStreamingRenderer implements StreamingRenderer {
  private readonly acc;
  /** Timestamp of the last activity state push to the store. */
  private lastUpdateTime: number = 0;
  /** Most recent activity state waiting to be flushed by the throttle timer. */
  private pendingActivity: import("../ui/activity-state").ActivityState | null = null;
  /** Timer handle for the throttled activity update. */
  private updateTimeoutId: ReturnType<typeof setTimeout> | null = null;
  /**
   * Minimum interval between React re-renders of the live area. 50ms (~20fps)
   * balances smooth streaming appearance with low CPU overhead.
   */
  private static readonly UPDATE_THROTTLE_MS = 50;

  private toolTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private static readonly TOOL_WARNING_MS = 30_000; // 30 seconds

  constructor(
    private readonly agentName: string,
    private readonly showMetrics: boolean,
    private readonly displayConfig: DisplayConfig,
  ) {
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
      this.acc.flushedTextOffset = 0;
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

      // Only print the portion not yet promoted to Static by the reducer's
      // paragraph flushing. Earlier content is already visible in Static.
      const unflushedText = this.acc.liveText.slice(this.acc.flushedTextOffset);
      if (unflushedText.trim().length > 0) {
        store.printOutput({ type: "log", message: unflushedText, timestamp: new Date() });
      }
      this.acc.liveText = "";
      this.acc.flushedTextOffset = 0;
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

      // Run the pure reducer
      const result = reduceEvent(
        this.acc,
        event,
        (text) => this.formatMarkdown(text),
        ink,
      );

      // Flush output side-effects immediately
      for (const entry of result.outputs) {
        store.printOutput(entry);
      }

      // Throttle high-frequency activity updates (streaming text / thinking).
      // Tool execution and other infrequent events are set immediately so the
      // spinner appears without delay after tool-call approval.
      if (result.activity) {
        const phase = result.activity.phase;
        if (phase === "thinking" || phase === "streaming") {
          // When text was flushed to Static (outputs produced during text_chunk),
          // bypass the throttle so the live area shrinks immediately, avoiding
          // brief duplication of the flushed content.
          if (event.type === "text_chunk" && result.outputs.length > 0) {
            this.lastUpdateTime = Date.now();
            this.pendingActivity = null;
            if (this.updateTimeoutId) {
              clearTimeout(this.updateTimeoutId);
              this.updateTimeoutId = null;
            }
            store.setActivity(result.activity);
          } else {
            this.throttledSetActivity(result.activity);
          }
        } else {
          this.lastUpdateTime = Date.now();
          this.pendingActivity = null;
          store.setActivity(result.activity);
        }
      }
    }).pipe(Effect.catchAllDefect((defect) => Effect.sync(() => {
      const message = defect instanceof Error ? defect.message : String(defect);
      store.printOutput({
        type: "warn",
        message: `Stream rendering error (${event.type}): ${message}`,
        timestamp: new Date(),
      });
    })));
  }

  private handleComplete(
    event: Extract<StreamEvent, { type: "complete" }>,
  ): void {
    // Cancel any pending throttled activity update so it doesn't fire after we clear
    if (this.updateTimeoutId) {
      clearTimeout(this.updateTimeoutId);
      this.updateTimeoutId = null;
      this.pendingActivity = null;
    }

    const wasStreaming = this.acc.lastAgentHeaderWritten;

    // Only the unflushed tail needs to go to Static here — earlier paragraphs
    // were already promoted during streaming via the reducer's flush logic.
    const unflushedTail = this.acc.liveText.slice(this.acc.flushedTextOffset);
    const finalText =
      unflushedTail.trim().length > 0
        ? unflushedTail
        : event.response.content.trim().length > 0
          ? event.response.content
          : "";
    const formattedFinalText = this.formatMarkdown(finalText);

    // Print to Static FIRST so the content is visible before the live area clears.
    // Ink's render cycle erases the live area, writes new static output, then
    // re-renders the live area — so brief duplication is invisible to the user.
    // The previous approach (clear live first, then print) caused a blank flash
    // where content vanished for one frame before reappearing in Static.
    if (formattedFinalText.length > 0) {
      if (wasStreaming) {
        // When we were streaming, the user already saw the agent header and reasoning
        // in the live area. Wrap in a padded Ink element to match the streaming
        // layout (paddingLeft=2) so text doesn't jump to full width on completion.
        store.printOutput({
          type: "log",
          message: ink(
            React.createElement(Box, { paddingLeft: 2 },
              React.createElement(Text, {}, formattedFinalText),
            ),
          ),
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
              content: formattedFinalText,
            }),
          ),
          timestamp: new Date(),
        });
      }
    }

    if (this.showMetrics && event.metrics) {
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

      // Calculate and display cost synchronously from cache when possible.
      // The models-dev map is cached in memory after the first fetch (which happens
      // during model selection), so this lookup is synchronous in practice.
      // Using a sync path avoids the cost line popping in after the prompt.
      if (usage && this.acc.currentProvider && this.acc.currentModel) {
        const provider = this.acc.currentProvider;
        const model = this.acc.currentModel;
        const promptTokens = usage.promptTokens;
        const completionTokens = usage.completionTokens;

        const printCost = (meta: { inputPricePerMillion?: number; outputPricePerMillion?: number } | undefined): void => {
          if (meta?.inputPricePerMillion !== undefined || meta?.outputPricePerMillion !== undefined) {
            const inputPrice = meta.inputPricePerMillion ?? 0;
            const outputPrice = meta.outputPricePerMillion ?? 0;
            const inputCost = (promptTokens / 1_000_000) * inputPrice;
            const outputCost = (completionTokens / 1_000_000) * outputPrice;
            const totalCost = inputCost + outputCost;

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
          }
          store.printOutput({ type: "log", message: "", timestamp: new Date() });
        };

        // Try synchronous cache hit first to avoid async print-after-prompt
        const cachedMeta = getModelsDevMetadataSync(model, provider);
        if (cachedMeta !== undefined) {
          printCost(cachedMeta);
        } else {
          // Fallback: async fetch (first run before cache is warm)
          void getModelsDevMetadata(model, provider)
            .then(printCost)
            .catch(() => {
              store.printOutput({ type: "log", message: "", timestamp: new Date() });
            });
        }
      } else {
        store.printOutput({ type: "log", message: "", timestamp: new Date() });
      }
    }

    // Clear the live area AFTER Static content is committed, so the user never
    // sees a blank frame where the streamed content has disappeared.
    store.setActivity({ phase: "idle" });
    store.setInterruptHandler(null);

    this.acc.liveText = "";
    this.acc.flushedTextOffset = 0;
    this.acc.reasoningBuffer = "";
    this.acc.completedReasoning = "";
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
   */
  private throttledSetActivity(
    activity: import("../ui/activity-state").ActivityState,
  ): void {
    const now = Date.now();
    const timeSinceLastUpdate = now - this.lastUpdateTime;

    if (timeSinceLastUpdate < InkStreamingRenderer.UPDATE_THROTTLE_MS) {
      // Always store the latest activity so the timer flushes the newest state
      this.pendingActivity = activity;
      if (!this.updateTimeoutId) {
        const delay = InkStreamingRenderer.UPDATE_THROTTLE_MS - timeSinceLastUpdate;
        this.updateTimeoutId = setTimeout(() => {
          this.updateTimeoutId = null;
          this.lastUpdateTime = Date.now();
          if (this.pendingActivity) {
            store.setActivity(this.pendingActivity);
            this.pendingActivity = null;
          }
        }, delay);
      }
      return;
    }

    this.lastUpdateTime = now;
    this.pendingActivity = null;
    store.setActivity(activity);
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
        type: "log",
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

    // Check if this is an execute_command tool — if so, offer "always approve" option
    const command = request.executeToolName === "execute_command"
      ? (typeof request.executeArgs["command"] === "string" ? request.executeArgs["command"] : null)
      : null;

    if (command) {
      // Three-option select: Yes / Yes and always approve / No
      const truncatedCmd = command.length > 60 ? command.slice(0, 57) + "..." : command;
      store.setPrompt({
        type: "select",
        message: "Approve this action?",
        options: {
          choices: [
            { label: "Yes", value: "yes" },
            { label: `Yes, and always approve "${truncatedCmd}" for this session`, value: "always" },
            { label: "No", value: "no" },
          ],
        },
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

          if (choice === "always") {
            store.setPrompt(null);
            this.completeApproval(resume, { approved: true, alwaysApproveCommand: command });
            return;
          }

          // Rejected: prompt for optional message to guide the agent
          this.promptRejectionMessage(resume);
        },
      });
    } else {
      // Non-command tool: standard Yes/No confirm
      store.setPrompt({
        type: "confirm",
        message: "Approve this action?",
        options: { defaultValue: true },
        resolve: (val: unknown) => {
          const approved = val as boolean;
          store.printOutput({
            type: "log",
            message: `Approve this action? ${CHALK_THEME.success(approved ? "Yes" : "No")}`,
            timestamp: new Date(),
          });

          if (approved) {
            store.setPrompt(null);
            this.completeApproval(resume, { approved: true });
            return;
          }

          // Rejected: prompt for optional message to guide the agent
          this.promptRejectionMessage(resume);
        },
      });
    }
  }

  /**
   * Show follow-up text prompt after a rejection to let the user guide the agent.
   */
  private promptRejectionMessage(
    resume: (effect: Effect.Effect<ApprovalOutcome, never>) => void,
  ): void {
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
            message: `${followUpMessage} ${CHALK_THEME.success(userMessage)}`,
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

    // Send system notification for user input request
    if (this.notificationService) {
      Effect.runFork(
        this.notificationService.notify(
          `Agent is asking a question`,
          {
            title: "Jazz Input Required",
            sound: true,
          },
        ).pipe(
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
        store.printOutput({
          type: "log",
          message: `${chalk.dim("Your response:")} ${CHALK_THEME.success(response)}`,
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
          store.printOutput({
            type: "log",
            message: `${chalk.dim("Selected:")} ${CHALK_THEME.success(selectedPath)}`,
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
