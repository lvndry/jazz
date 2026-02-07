import chalk from "chalk";
import { Effect, Layer, Option } from "effect";
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
import { createAccumulator, reduceEvent } from "./activity-reducer";
import { CLIRenderer, type CLIRendererConfig } from "./cli-renderer";
import { formatMarkdown, formatMarkdownHybrid } from "./markdown-formatter";
import { AgentResponseCard } from "../ui/AgentResponseCard";
import { setLastExpandedDiff } from "../ui/diff-expansion-store";
import { store } from "../ui/store";

export class InkStreamingRenderer implements StreamingRenderer {
  private readonly acc;
  private lastUpdateTime: number = 0;
  private pendingActivity: import("../ui/activity-state").ActivityState | null = null;
  private updateTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private static readonly UPDATE_THROTTLE_MS = 30;

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
      this.lastUpdateTime = 0;
      this.pendingActivity = null;
      if (this.updateTimeoutId) {
        clearTimeout(this.updateTimeoutId);
        this.updateTimeoutId = null;
      }
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

      if (this.acc.liveText.trim().length > 0) {
        store.printOutput({ type: "log", message: this.acc.liveText, timestamp: new Date() });
      }
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
          this.acc.activeTools.get(event.toolCallId),
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

      // Flush log side-effects immediately
      for (const log of result.logs) {
        store.printOutput(log);
      }

      // Throttle activity state updates
      if (result.activity) {
        this.throttledSetActivity(result.activity);
      }
    }).pipe(Effect.catchAll((error) => Effect.sync(() => {
      // Log swallowed errors to stderr for debugging missing tool call events
      if (process.env["DEBUG"]) {
        console.error(`[InkStreamingRenderer] handleEvent error for ${event.type}:`, error);
      }
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

    // Clear the live area FIRST to avoid the visual jump where content appears
    // in both the live area and Static simultaneously
    store.setActivity({ phase: "idle" });
    store.setInterruptHandler(null);

    const finalText =
      this.acc.liveText.trim().length > 0
        ? this.acc.liveText
        : event.response.content.trim().length > 0
          ? event.response.content
          : "";
    const formattedFinalText = this.formatMarkdown(finalText);

    if (formattedFinalText.length > 0) {
      if (wasStreaming) {
        // When we were streaming, the user already saw the agent header and reasoning
        // in the live area. Just flush the response text to Static as-is — no card
        // wrapper — so the content height stays consistent and avoids a visual jump.
        store.printOutput({
          type: "log",
          message: formattedFinalText,
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

      // Calculate and display cost asynchronously
      if (usage && this.acc.currentProvider && this.acc.currentModel) {
        const provider = this.acc.currentProvider;
        const model = this.acc.currentModel;
        const promptTokens = usage.promptTokens;
        const completionTokens = usage.completionTokens;

        void getModelsDevMetadata(model, provider)
          .then((meta) => {
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
              store.printOutput({ type: "log", message: "", timestamp: new Date() });
            }
          })
          .catch(() => {});
      } else {
        store.printOutput({ type: "log", message: "", timestamp: new Date() });
      }
    }

    this.acc.liveText = "";
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
        setLastExpandedDiff(fullDiff);
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
