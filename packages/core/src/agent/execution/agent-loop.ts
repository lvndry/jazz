/**
 * The core iterate-call-tools-until-done loop shared by the batch and streaming
 * executors: runs LLM calls, dispatches tool calls, applies context-ladder
 * pressure checks between iterations, and detects tool-call meltdowns.
 */

import { Cause, Effect, Fiber, Option, Ref } from "effect";
import { isRunParkRequested, withTranscript } from "@/core/agent/run/park-signal";
import { isLocalServerProvider } from "@/core/constants/local-providers";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
import type { LLMService } from "@/core/interfaces/llm";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import type { PresentationService, StreamingRenderer } from "@/core/interfaces/presentation";
import type { ToolRegistry, ToolRequirements } from "@/core/interfaces/tool-registry";
import type { ChatMessage, ConversationMessages } from "@/core/types";
import { parseGeneratedArtifacts } from "@/core/types/artifact";
import {
  type AttachmentKind,
  describeAttachment,
  MAX_ATTACHMENTS_PER_MESSAGE,
  type MessageAttachment,
} from "@/core/types/attachment";
import type { ChatCompletionResponse } from "@/core/types/chat";
import { GenerationInterruptedError, LLMRateLimitError } from "@/core/types/errors";
import type { DisplayConfig } from "@/core/types/output";
import type { StreamEvent } from "@/core/types/streaming";
import { conversationLogGroup } from "@/core/utils/log-group";
import { getModelsDevMetadata } from "@/core/utils/models-dev";
import { formatToolResultForContext } from "@/core/utils/tool-result-formatter";
import type { UsageCostPricing } from "@/core/utils/usage-cost";
import type { AgentLoopObserver } from "./agent-loop-observer";
import { ToolExecutor } from "./tool-executor";
import { logContextRung } from "../context/context-telemetry";
import { resolveContextThresholds } from "../context/context-thresholds";
import {
  CONTEXT_COMPACT_THRESHOLD_RATIO,
  CONTEXT_TRIM_THRESHOLD_RATIO,
  CONTEXT_WARN_THRESHOLD_RATIO,
  ContextWindowManager,
  DEFAULT_CONTEXT_WINDOW_MANAGER,
  protectedZoneStartIndex,
} from "../context/context-window-manager";
import {
  describeContextWindowShortfall,
  resolveEffectiveContextWindow,
} from "../context/effective-context-window";
import { Summarizer, type RecursiveRunner } from "../context/summarizer";
import { clearToolResults } from "../context/tool-result-clearing";
import {
  beginIteration,
  calibrateTokenCounter,
  completeIteration,
  computeRunCost,
  emitAgentRunFailed,
  emitLLMUsage,
  estimateTokens,
  finalizeAgentRun,
  recordLLMUsage,
  recordToolDefinitionTokens,
  recordToolResultTokens,
  type AgentRunMetrics,
} from "../metrics/agent-run-metrics";
import type { AgentResponse, AgentRunContext, AgentRunnerOptions } from "../types";

/**
 * Returns an ephemeral budget pressure message at 70%/90% iteration thresholds.
 * Returns null below 70%. Must NOT be pushed to currentMessages — pass ephemerally only.
 */
export function buildBudgetPressureMessage(
  iteration: number,
  maxIterations: number,
): { role: "user"; content: string } | null {
  const pct = iteration / maxIterations;
  if (pct >= 0.9) {
    return {
      role: "user",
      content: `[BUDGET CRITICAL: Iteration ${iteration}/${maxIterations} (${Math.round(pct * 100)}%). Write your final output NOW. No further research or subagent spawning. Use what you have collected so far.]`,
    };
  }
  if (pct >= 0.7) {
    return {
      role: "user",
      content: `[BUDGET WARNING: Iteration ${iteration}/${maxIterations} (${Math.round(pct * 100)}%). Begin consolidating results. Stop spawning new research subagents. Move to consolidation and output phases.]`,
    };
  }
  return null;
}

/**
 * Shared 50%/80%/90% tiering for the maxCostUSD/maxTokens/maxDurationMs pressure nudges
 * below. Returns null under 50%. Must NOT be pushed to currentMessages — ephemeral only,
 * same reasoning as `buildBudgetPressureMessage` above (a persisted warning wastes tokens
 * and gets summarized into the very compaction it warned about).
 */
function budgetPressureMessage(
  pct: number,
  label: string,
  progress: string,
): { role: "user"; content: string } | null {
  const percent = Math.round(pct * 100);
  if (pct >= 0.9) {
    return {
      role: "user",
      content: `[${label} CRITICAL: ${progress} (${percent}%). Write your final output NOW. No further research or subagent spawning.]`,
    };
  }
  if (pct >= 0.8) {
    return {
      role: "user",
      content: `[${label} WARNING: ${progress} (${percent}%). Begin consolidating results. Stop spawning new research subagents. Move to consolidation and output phases.]`,
    };
  }
  if (pct >= 0.5) {
    return {
      role: "user",
      content: `[${label} NOTICE: ${progress} (${percent}%). You are past the halfway point of your ${label.toLowerCase()} budget — plan to wrap up well before it runs out.]`,
    };
  }
  return null;
}

/**
 * Returns an ephemeral time-budget pressure message at 50%/80%/90% of `maxDurationMs` elapsed.
 */
export function buildTimeBudgetPressureMessage(
  elapsedMs: number,
  maxDurationMs: number,
): { role: "user"; content: string } | null {
  if (maxDurationMs <= 0) return null;
  const minutesUsed = Math.round(elapsedMs / 60_000);
  const minutesBudget = Math.round(maxDurationMs / 60_000);
  return budgetPressureMessage(
    elapsedMs / maxDurationMs,
    "TIME",
    `${minutesUsed}/${minutesBudget} minutes used`,
  );
}

/**
 * Returns an ephemeral token-budget pressure message at 50%/80%/90% of `maxTokens` used
 * (own prompt + completion tokens accumulated so far).
 */
export function buildTokenBudgetPressureMessage(
  totalTokens: number,
  maxTokens: number,
): { role: "user"; content: string } | null {
  if (maxTokens <= 0) return null;
  return budgetPressureMessage(
    totalTokens / maxTokens,
    "TOKEN",
    `${totalTokens.toLocaleString()}/${maxTokens.toLocaleString()} tokens used`,
  );
}

/**
 * Returns an ephemeral cost-budget pressure message at 50%/80%/90% of `maxCostUSD` spent.
 */
export function buildCostBudgetPressureMessage(
  costUSD: number,
  maxCostUSD: number,
): { role: "user"; content: string } | null {
  if (maxCostUSD <= 0) return null;
  return budgetPressureMessage(
    costUSD / maxCostUSD,
    "COST",
    `$${costUSD.toFixed(4)}/$${maxCostUSD.toFixed(4)} spent`,
  );
}

/** Share of the context budget past which the agent is told to stop gathering and write. */
const CONTEXT_CRITICAL_RATIO = 0.9;

/**
 * Tell the model its context is running out, mirroring the iteration-budget nudge.
 *
 * Without this the agent only learns about compaction after the fact, by finding its
 * history rewritten underneath it. Warned in advance it can consolidate what it has
 * while the detail is still there to consolidate.
 */
export function buildContextPressureMessage(
  currentTokens: number,
  budgetTokens: number,
  thresholds?: { warnThresholdRatio: number; compactThresholdRatio: number },
): { role: "user"; content: string } | null {
  if (budgetTokens <= 0) return null;
  const warnRatio = thresholds?.warnThresholdRatio ?? CONTEXT_WARN_THRESHOLD_RATIO;
  const compactRatio = thresholds?.compactThresholdRatio ?? CONTEXT_COMPACT_THRESHOLD_RATIO;
  const ratio = currentTokens / budgetTokens;
  const percent = Math.round(ratio * 100);
  const budget = budgetTokens.toLocaleString();

  if (ratio >= CONTEXT_CRITICAL_RATIO) {
    return {
      role: "user",
      content: `[CONTEXT CRITICAL: ${percent}% of the ${budget}-token context budget used. Write your final output NOW from what you have already gathered. Do not open new files, run new searches, or spawn subagents — their results may not survive compaction.]`,
    };
  }
  if (ratio >= warnRatio) {
    return {
      role: "user",
      content: `[CONTEXT WARNING: ${percent}% of the ${budget}-token context budget used. Older history is summarized automatically at ${Math.round(compactRatio * 100)}%, and detail is lost when that happens. Record any findings you need to keep in your next message, and prefer consolidating over gathering more.]`,
    };
  }
  return null;
}

/**
 * After a successful compaction the history has been rewritten underneath the
 * model. The warn/critical nudges tell it to wrap up — the opposite of what
 * just happened: space was freed so the original task can continue.
 */
export function buildPostCompactionMessage(
  currentTokens: number,
  budgetTokens: number,
): { role: "user"; content: string } {
  const resume =
    "[CONTEXT COMPACTED: Older history was summarized to free space. The original task is still in progress. Continue from the summary and recent messages until the user's request is fully complete. Do not treat this compaction as a reason to wrap up.]";
  if (budgetTokens <= 0) return { role: "user", content: resume };

  const ratio = currentTokens / budgetTokens;
  if (ratio < CONTEXT_CRITICAL_RATIO) return { role: "user", content: resume };

  const percent = Math.round(ratio * 100);
  const budget = budgetTokens.toLocaleString();
  return {
    role: "user",
    content: `${resume} Context is still ${percent}% of the ${budget}-token budget — prefer finishing current work over opening new investigations, but do not stop short of the original request.`,
  };
}

export interface TrackedToolCall {
  name: string;
  arguments: string;
}

interface LoopState {
  currentMessages: ConversationMessages;
  response: AgentResponse;
  recentToolCalls: TrackedToolCall[];
  iterationsUsed: number;
  contextPressureWarned: boolean;
  toolResultsCleared: boolean;
}

interface LoopDeps {
  agent: AgentRunnerOptions["agent"];
  options: AgentRunnerOptions;
  actualConversationId: string;
  context: AgentRunContext["context"];
  tools: AgentRunContext["tools"];
  provider: AgentRunContext["provider"];
  model: string;
  runMetrics: AgentRunMetrics;
  contextWindowMaxTokens: number;
  runContextWindowManager: ContextWindowManager;
  displayConfig: DisplayConfig;
  strategy: CompletionStrategy;
  observer: AgentLoopObserver;
  logger: LoggerService;
  maxIterations: number;
  /** Cost/token/duration ceilings and pricing, for the ephemeral pressure nudges. Undefined = uncapped. */
  maxCostUSD: number | undefined;
  maxTokens: number | undefined;
  maxDurationMs: number | undefined;
  modelMetadata: UsageCostPricing | undefined;
  runRecursive: RecursiveRunner;
  /**
   * Attachment modalities this run's model accepts. Passed to tools so `read_file` on a
   * screenshot can attach it, or explain why it cannot.
   */
  supportedAttachmentKinds: readonly AttachmentKind[];
}

export const MELTDOWN_WINDOW_SIZE = 10;

/**
 * Returns true when recent tool calls show low diversity — the agent is stuck in a loop.
 *
 * Uniqueness is measured on the composite key `name:arguments` so that two tools
 * alternating with *different* arguments (e.g. web_search → web_fetch → web_search on
 * a new query) are correctly treated as productive. Only identical name+argument pairs
 * repeated across the window trigger the 40% threshold.
 */
export function detectMeltdown(
  recentToolCalls: TrackedToolCall[],
  windowSize = MELTDOWN_WINDOW_SIZE,
): boolean {
  if (recentToolCalls.length < windowSize) return false;
  const window = recentToolCalls.slice(-windowSize);
  const keys = window.map((tc) => `${tc.name}:${tc.arguments}`);
  const uniqueness = new Set(keys).size / windowSize;
  return uniqueness < 0.4;
}

/**
 * Strategy interface for obtaining and presenting completions.
 * Implementations differ for streaming vs batch mode.
 */
export interface CompletionStrategy {
  /**
   * Obtain a completion from the LLM.
   * Returns the completion and whether the generation was interrupted.
   */
  getCompletion(
    messages: ConversationMessages,
    iteration: number,
  ): Effect.Effect<
    { completion: ChatCompletionResponse; interrupted: boolean },
    LLMRateLimitError | Error,
    LLMService | LoggerService
  >;

  /**
   * Present the final response to the user (no tool calls).
   * Streaming mode: sends completion event + desktop notification.
   * Batch mode: renders markdown + displays response text + shows metrics.
   */
  presentResponse(
    agentName: string,
    content: string,
    completion: ChatCompletionResponse,
  ): Effect.Effect<void, never, PresentationService | LoggerService>;

  /**
   * Called when the agent loop finishes (no more tool calls).
   * Streaming: sends notification. Batch: no-op.
   */
  onComplete(
    agentName: string,
    completion: ChatCompletionResponse,
  ): Effect.Effect<void, never, PresentationService>;

  /**
   * Return the streaming renderer if available, null otherwise.
   * Used by tool executor for rendering tool execution events.
   */
  getRenderer(): StreamingRenderer | null;

  /**
   * Optional interrupt signal (e.g. Deferred.await) used to interrupt tool execution
   * when the user triggers double-Escape. When provided, tool execution races with
   * this effect so double-Esc during a tool call stops the tools and breaks the loop.
   */
  getInterruptSignal?(): Effect.Effect<void, never> | undefined;

  /**
   * Optional background signal (Ctrl+B) used to detach the in-flight tool batch instead
   * of interrupting it: the batch's fibers keep running (forked as daemon fibers so they
   * outlive this tool phase), and each returns a "running in the background" placeholder
   * result immediately so the loop continues. Unlike `getInterruptSignal`, firing this
   * does not abort the run, and it must be re-triggerable across many tool batches within
   * one run — implementations should not reuse a single one-shot `Deferred` the way
   * `getInterruptSignal` does.
   */
  getBackgroundSignal?(): Effect.Effect<void, never> | undefined;

  /**
   * Whether to show reasoning indicators for this strategy.
   */
  shouldShowReasoning: boolean;
}

interface FinalizeInput {
  response: AgentResponse;
  currentMessages: ConversationMessages;
  runMetrics: AgentRunMetrics;
  modelMetadata: UsageCostPricing | undefined;
  iterationsUsed: number;
  finished: boolean;
  interrupted: boolean;
  costCapped: boolean;
  tokenCapped: boolean;
  durationCapped: boolean;
}

/**
 * Post-loop finalization: iteration-limit/empty-response warnings, kicking off
 * the async metrics/telemetry write (tracked via `finalizeFiberRef` so the caller
 * can await it during release), cost computation, and `AgentResponse` assembly.
 */
function finalizeRun(
  input: FinalizeInput,
  observer: AgentLoopObserver,
  logger: LoggerService,
  agentName: string,
  maxIterations: number,
  finalizeFiberRef: Ref.Ref<Option.Option<Fiber.RuntimeFiber<void, Error>>>,
): Effect.Effect<AgentResponse, never, LoggerService> {
  return Effect.gen(function* () {
    const {
      response,
      currentMessages,
      runMetrics,
      modelMetadata,
      finished,
      interrupted,
      costCapped,
      tokenCapped,
      durationCapped,
    } = input;
    const capped = costCapped || tokenCapped || durationCapped;
    let iterationsUsed = input.iterationsUsed;

    if (!finished) {
      iterationsUsed = capped ? input.iterationsUsed : maxIterations;
      if (!capped) {
        yield* observer.onIterationLimit(agentName, maxIterations);
      }
    } else if (
      !response.content?.trim() &&
      !response.reasoning?.trim() &&
      !response.toolCalls &&
      !interrupted
    ) {
      yield* observer.onEmptyResponse(agentName);
    }

    yield* logger.debug("Finalizing agent run", {
      interrupted,
      finished,
      costCapped,
      tokenCapped,
      durationCapped,
    });

    const finalizeFiber = yield* finalizeAgentRun(runMetrics, {
      iterationsUsed,
      finished,
      costCapped: capped,
    }).pipe(
      Effect.catchAll((error) =>
        logger.warn("Failed to write agent token usage log", { error: error.message }),
      ),
      Effect.fork,
    );
    yield* Ref.set(finalizeFiberRef, Option.some(finalizeFiber));

    // A partial figure must never pass for a complete one: cost-capped callers
    // (bridge daily caps, the per-run maxCostUSD guard) treat costIncomplete as
    // unpriced spend and refuse to enforce a cap they cannot verify.
    const { costUSD, costIncomplete } = computeRunCost(runMetrics, modelMetadata);

    return {
      ...response,
      messages: currentMessages,
      usage: {
        promptTokens: runMetrics.totalPromptTokens,
        completionTokens: runMetrics.totalCompletionTokens,
        ...(runMetrics.totalCacheReadTokens > 0 && {
          cacheReadTokens: runMetrics.totalCacheReadTokens,
        }),
      },
      ...(costUSD !== undefined ? { costUSD } : {}),
      ...(costIncomplete ? { costIncomplete: true } : {}),
      ...(costCapped ? { costCapped: true } : {}),
      ...(tokenCapped ? { tokenCapped: true } : {}),
      ...(durationCapped ? { durationCapped: true } : {}),
    };
  });
}

/**
 * Close out assistant `tool_calls` that never got a `role: "tool"` result so the
 * transcript stays valid for the next LLM request. Used when the user interrupts
 * mid-batch: executeToolCalls fails before handleToolPhase can append results.
 */
function closeDanglingToolCalls(state: LoopState): void {
  const lastAssistant = [...state.currentMessages]
    .reverse()
    .find((message) => message.role === "assistant" && (message.tool_calls?.length ?? 0) > 0);
  if (lastAssistant?.tool_calls === undefined) return;

  const existing = new Set(
    state.currentMessages
      .filter((message) => message.role === "tool" && message.tool_call_id !== undefined)
      .map((message) => message.tool_call_id),
  );

  for (const toolCall of lastAssistant.tool_calls) {
    if (existing.has(toolCall.id)) continue;
    state.currentMessages.push({
      role: "tool",
      name: toolCall.function.name,
      content: "Tool execution interrupted by user",
      tool_call_id: toolCall.id,
    });
  }
}

/**
 * Handles the tool-call branch of a single loop iteration: executes the tool
 * calls, validates every call produced a result, appends tool-result messages,
 * runs meltdown detection/recovery injection, and applies budget/queued-message
 * handling. Mutates `state` in place (currentMessages, recentToolCalls, response).
 *
 * A user interrupt during tools returns `"interrupted"` instead of failing the
 * run — the same clean stop as interrupting the LLM stream.
 */
function handleToolPhase(
  state: LoopState,
  toolCalls: NonNullable<ChatCompletionResponse["toolCalls"]>,
  reasoningContent: string,
  iterationIndex: number,
  deps: LoopDeps,
): Effect.Effect<
  "continue" | "interrupted",
  Error,
  ToolRegistry | LoggerService | AgentConfigService | ToolRequirements | PresentationService
> {
  const {
    agent,
    actualConversationId,
    context,
    contextWindowMaxTokens,
    runContextWindowManager,
    displayConfig,
    strategy,
    runMetrics,
    options,
    logger,
    observer,
    provider,
    supportedAttachmentKinds,
  } = deps;

  return Effect.gen(function* () {
    yield* logger.info("Agent decided to use tools", {
      agentId: agent.id,
      conversationId: actualConversationId,
      iteration: iterationIndex + 1,
      toolsChosen: toolCalls.map((tc) => tc.function.name),
      reasoning: reasoningContent,
    });

    for (const toolCall of toolCalls) {
      if (toolCall.type === "function") {
        state.recentToolCalls.push({
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        });
      }
    }

    if (state.recentToolCalls.length > MELTDOWN_WINDOW_SIZE) {
      state.recentToolCalls.splice(0, state.recentToolCalls.length - MELTDOWN_WINDOW_SIZE);
    }

    if (detectMeltdown(state.recentToolCalls)) {
      yield* logger.warn("Meltdown detected — injecting recovery signal", {
        agentId: agent.id,
        recentTools: state.recentToolCalls.slice(-10).map((tc) => tc.name),
      });
      state.currentMessages.push({
        role: "user",
        content:
          "[MELTDOWN DETECTED: You have been repeating the same tool calls without progress. Stop the current approach. Summarize what you have found so far, identify what is still missing, and either proceed directly to output or try a fundamentally different search strategy. Do not repeat your last action.]",
      });
      state.recentToolCalls.length = 0;
    }

    const toolRenderer = strategy.getRenderer();

    // Media a tool attached during this batch of tool calls. Collected here rather than
    // returned through tool results because tool results are text-only — the actual bytes have
    // to ride on a user message, which is appended once the batch finishes.
    const pendingAttachments: MessageAttachment[] = [];

    const contextWithTokenStats = {
      ...context,
      tokenStats: {
        currentTokens: runContextWindowManager.calculateTotalTokens(state.currentMessages),
        maxTokens: contextWindowMaxTokens,
      },
      conversationMessages: state.currentMessages,
      parentAgent: agent,
      compactConversation: (compacted: readonly ChatMessage[]) => {
        state.currentMessages = [
          state.currentMessages[0],
          ...compacted.slice(1),
        ] as typeof state.currentMessages;
      },
      recordChildCost: (costUSD: number) => {
        runMetrics.childCostUSD += costUSD;
      },
      recordChildCostUnknown: () => {
        runMetrics.childCostUnknown = true;
      },
      attachMedia: (attachment: MessageAttachment) => {
        if (pendingAttachments.length >= MAX_ATTACHMENTS_PER_MESSAGE) return;
        pendingAttachments.push(attachment);
      },
      supportedAttachmentKinds: supportedAttachmentKinds,
      attachmentsAreLocal: isLocalServerProvider(provider),
      // Let tools surface live progress (e.g. spawn_subagent lifecycle) through
      // the same event stream, when a streaming renderer is present.
      ...(toolRenderer
        ? { emitEvent: (event: StreamEvent) => toolRenderer.handleEvent(event) }
        : {}),
    };

    const toolResults = yield* ToolExecutor.executeToolCalls(
      toolCalls,
      contextWithTokenStats,
      displayConfig,
      toolRenderer,
      runMetrics,
      agent.id,
      actualConversationId,
      agent.name,
      strategy.getInterruptSignal?.(),
      strategy.getBackgroundSignal?.(),
      options.onDetachedToolComplete,
    ).pipe(
      // The executor knows what the run is waiting for; only here are the messages that
      // let it start again. Everything else about the failure is left alone.
      Effect.catchIf(isRunParkRequested, (signal) =>
        Effect.fail(withTranscript(signal, state.currentMessages, state.iterationsUsed)),
      ),
    );

    // Validate all tool calls have results
    const resultMap = new Map(toolResults.map((r) => [r.toolCallId, r.result]));
    const missingResults: string[] = [];
    for (const toolCall of toolCalls) {
      if (toolCall.type === "function" && !resultMap.has(toolCall.id)) {
        missingResults.push(toolCall.id);
      }
    }
    if (missingResults.length > 0) {
      yield* logger.error("Missing tool results for some tool calls", {
        agentId: agent.id,
        conversationId: actualConversationId,
        missingToolCallIds: missingResults,
        expectedCount: toolCalls.length,
        actualCount: toolResults.length,
      });
      return yield* Effect.fail(
        new Error(
          `Missing tool results for ${missingResults.length} tool call(s). This indicates a bug in tool execution.`,
        ),
      );
    }

    // Add tool result messages
    for (const toolCall of toolCalls) {
      if (toolCall.type === "function") {
        const result = resultMap.get(toolCall.id);
        if (result === undefined) {
          yield* logger.error("Tool result is undefined despite validation", {
            agentId: agent.id,
            conversationId: actualConversationId,
            toolCallId: toolCall.id,
            toolName: toolCall.function.name,
          });
          state.currentMessages.push({
            role: "tool",
            name: toolCall.function.name,
            content: formatToolResultForContext(toolCall.function.name, {
              error: "Tool execution result was undefined",
            }),
            tool_call_id: toolCall.id,
          });
        } else {
          const formattedResult = formatToolResultForContext(toolCall.function.name, result);
          state.currentMessages.push({
            role: "tool",
            name: toolCall.function.name,
            content: formattedResult,
            tool_call_id: toolCall.id,
          });
          recordToolResultTokens(runMetrics, toolCall.function.name, formattedResult.length);
        }
      }
    }

    // Media attached by tools rides on a user message after the tool results. A `role: "tool"`
    // message cannot carry file parts across providers, and a user message can — so this is the
    // one shape that delivers a screenshot the model just asked to read.
    if (pendingAttachments.length > 0) {
      const descriptions = pendingAttachments.map(describeAttachment).join("\n");
      state.currentMessages.push({
        role: "user",
        content: `Attached from the tool call above:\n${descriptions}`,
        attachments: [...pendingAttachments],
      });
      yield* logger.debug("Attached media to conversation", {
        agentId: agent.id,
        count: pendingAttachments.length,
        kinds: pendingAttachments.map((attachment) => attachment.kind),
      });
      pendingAttachments.length = 0;
    }

    // Accumulated across the whole run, unlike toolResults, which keeps only the last call per
    // tool name — two create_pdf calls have to produce two files, not one.
    const producedArtifacts = toolResults.flatMap((toolResult) =>
      parseGeneratedArtifacts(
        (toolResult.result as { artifacts?: unknown } | undefined)?.artifacts,
      ),
    );

    state.response = {
      ...state.response,
      toolCalls: [...(state.response.toolCalls ?? []), ...toolCalls],
      toolResults: {
        ...state.response.toolResults,
        ...Object.fromEntries(toolResults.map((r) => [r.name, r.result])),
      },
      ...(producedArtifacts.length > 0
        ? { artifacts: [...(state.response.artifacts ?? []), ...producedArtifacts] }
        : {}),
    };

    const queuedMessage = options.checkQueuedMessage?.();
    if (queuedMessage) {
      state.currentMessages.push({ role: "user", content: queuedMessage });
    }
  }).pipe(
    Effect.as("continue" as const),
    Effect.catchIf(
      (error): error is GenerationInterruptedError => error instanceof GenerationInterruptedError,
      () =>
        Effect.gen(function* () {
          closeDanglingToolCalls(state);
          yield* observer.onInterrupted(agent.name);
          const renderer = strategy.getRenderer();
          if (renderer) {
            yield* renderer.reset();
          }
          yield* logger.debug("Tool execution interrupted, breaking loop");
          return "interrupted" as const;
        }),
    ),
  );
}

type RunIterationResult = { kind: "continue" } | { kind: "final" } | { kind: "interrupted" };

/**
 * Runs one full loop iteration: context compaction, LLM request logging,
 * `strategy.getCompletion`, usage recording, assistant message build + trim,
 * then either delegates to `handleToolPhase` (tool branch → "continue") or
 * handles the final-response presentation (→ "final"). An interrupted
 * completion short-circuits to "interrupted". Mutates `state` in place.
 */
function runIteration(
  state: LoopState,
  iterationIndex: number,
  deps: LoopDeps,
): Effect.Effect<
  RunIterationResult,
  LLMRateLimitError | Error,
  | LLMService
  | ToolRegistry
  | LoggerService
  | AgentConfigService
  | PresentationService
  | ToolRequirements
> {
  const {
    agent,
    options,
    actualConversationId,
    tools,
    provider,
    model,
    runMetrics,
    contextWindowMaxTokens,
    runContextWindowManager,
    strategy,
    observer,
    logger,
    maxIterations,
    maxCostUSD,
    maxTokens,
    maxDurationMs,
    modelMetadata,
    runRecursive,
  } = deps;

  return Effect.gen(function* () {
    if (!options.internal && strategy.shouldShowReasoning) {
      yield* observer.onThinking(agent.name, iterationIndex === 0);
    }

    // Cheapest rung first: drop stale raw tool output before spending an LLM call on
    // summarizing. Gated on `toolResultsCleared` so it runs once per crossing —
    // rewriting the prefix every turn would reintroduce the cache churn that the
    // trim-budget fix removed.
    if (
      !state.toolResultsCleared &&
      runContextWindowManager.shouldClearToolResults(state.currentMessages)
    ) {
      const before = runContextWindowManager.totalRequestTokens(state.currentMessages);
      const cleared = clearToolResults(state.currentMessages, {
        protectedFromIndex: protectedZoneStartIndex(
          state.currentMessages,
          DEFAULT_CONTEXT_WINDOW_MANAGER.getConfig().protectedRecentTurns ?? 2,
        ),
        modelHint: { provider, modelId: model },
      });
      if (cleared.clearedCount > 0) {
        state.toolResultsCleared = true;
        state.currentMessages = [
          state.currentMessages[0],
          ...cleared.messages.slice(1),
        ] as typeof state.currentMessages;
        yield* logContextRung(logger, {
          rung: "clear",
          agentId: agent.id,
          conversationId: actualConversationId,
          tokensBefore: before,
          tokensAfter: runContextWindowManager.totalRequestTokens(state.currentMessages),
          budgetTokens: runContextWindowManager.contextBudgetTokens,
          messagesBefore: state.currentMessages.length,
          messagesAfter: state.currentMessages.length,
        });
      }
    }

    const contextUsage = runContextWindowManager.usage(state.currentMessages);
    if (contextUsage.shouldWarn && !contextUsage.shouldCompact && !state.contextPressureWarned) {
      state.contextPressureWarned = true;
      yield* logger.info("Context window filling up", {
        agentId: agent.id,
        conversationId: actualConversationId,
        currentTokens: contextUsage.currentTokens,
        budgetTokens: contextUsage.budgetTokens,
      });
      if (!options.internal) {
        yield* observer.onContextPressure(
          agent.name,
          Math.round(contextUsage.ratio * 100),
          contextUsage.budgetTokens,
        );
      }
    }

    const messagesBeforeCompact = state.currentMessages;
    state.currentMessages = yield* Summarizer.compactIfNeeded(
      state.currentMessages,
      agent,
      actualConversationId,
      runRecursive,
      contextWindowMaxTokens,
    );
    const justCompacted = state.currentMessages !== messagesBeforeCompact;

    // The summarizer is its own agent run; its completion idles the live zone.
    // Restore thinking so the parent looks mid-task, not finished.
    if (justCompacted && !options.internal && strategy.shouldShowReasoning) {
      yield* observer.onThinking(agent.name, false);
    }

    let lastUserContent: string | undefined;
    for (let j = state.currentMessages.length - 1; j >= 0; j--) {
      if (state.currentMessages[j]?.role === "user") {
        lastUserContent = state.currentMessages[j]?.content;
        break;
      }
    }

    yield* logger.debug("Sending LLM request", {
      agentId: agent.id,
      conversationId: actualConversationId,
      iteration: iterationIndex + 1,
      provider,
      model,
      messageCount: state.currentMessages.length,
      toolsAvailable: tools.length,
      reasoningEffort: agent.config.reasoningEffort,
      lastUserMessage: lastUserContent,
    });

    // Both nudges are ephemeral: appended to this request only, never pushed into
    // history. A persisted warning would cost tokens exactly when they are scarce,
    // be re-sent every turn, and end up summarized into the compaction it warned about.
    const postCompactionUsage = runContextWindowManager.usage(state.currentMessages);
    const contextMsg = justCompacted
      ? buildPostCompactionMessage(
          postCompactionUsage.currentTokens,
          postCompactionUsage.budgetTokens,
        )
      : buildContextPressureMessage(
          postCompactionUsage.currentTokens,
          postCompactionUsage.budgetTokens,
          runContextWindowManager.thresholdRatios,
        );
    const budgetMsg = buildBudgetPressureMessage(iterationIndex + 1, maxIterations);
    const timeBudgetMsg =
      maxDurationMs !== undefined
        ? buildTimeBudgetPressureMessage(Date.now() - runMetrics.startedAt.getTime(), maxDurationMs)
        : null;
    const tokenBudgetMsg =
      maxTokens !== undefined
        ? buildTokenBudgetPressureMessage(
            runMetrics.totalPromptTokens + runMetrics.totalCompletionTokens,
            maxTokens,
          )
        : null;
    // Reuses the same cost math as the hard-stop check in the outer loop (computeRunCost),
    // so the nudge and the eventual cutoff never disagree about how much has been spent.
    const costBudgetMsg =
      maxCostUSD !== undefined
        ? (() => {
            const runCost = computeRunCost(runMetrics, modelMetadata);
            return runCost.costUSD !== undefined
              ? buildCostBudgetPressureMessage(runCost.costUSD, maxCostUSD)
              : null;
          })()
        : null;
    const pressureContent = [
      contextMsg?.content,
      budgetMsg?.content,
      timeBudgetMsg?.content,
      tokenBudgetMsg?.content,
      costBudgetMsg?.content,
    ]
      .filter(Boolean)
      .join("\n");
    const messagesForLLM = pressureContent
      ? ([
          ...state.currentMessages,
          { role: "user" as const, content: pressureContent },
        ] as typeof state.currentMessages)
      : state.currentMessages;

    const completionStartTime = Date.now();
    const result = yield* strategy.getCompletion(messagesForLLM, iterationIndex);
    const completionDurationMs = Date.now() - completionStartTime;

    if (result.interrupted) {
      const completion = result.completion;
      state.response = {
        ...state.response,
        content: completion.content,
        ...(completion.toolCalls ? { toolCalls: completion.toolCalls } : {}),
      };

      if (completion.content.length > 0) {
        state.currentMessages.push({
          role: "assistant",
          content: completion.content,
        });
      }
      yield* observer.onInterrupted(agent.name);
      yield* logger.debug("Interruption handled, breaking loop");
      return { kind: "interrupted" } as const;
    }

    const { completion } = result;

    // Log LLM response summary
    yield* logger.debug("LLM response received", {
      agentId: agent.id,
      conversationId: actualConversationId,
      iteration: iterationIndex + 1,
      contentLength: completion.content.length,
      toolCallsCount: completion.toolCalls?.length ?? 0,
      tokenUsage: completion.usage,
      contentPreview: completion.content.substring(0, 300),
    });

    if (completion.usage) {
      recordLLMUsage(runMetrics, completion.usage);
      yield* emitLLMUsage(runMetrics, completion.usage, completionDurationMs);

      calibrateTokenCounter({
        authoritativePromptTokens: completion.usage.promptTokens,
        messagesAtCallTime: state.currentMessages,
        provider,
        modelId: model,
      });
    }

    if (completion.toolDefinitionChars != null) {
      recordToolDefinitionTokens(
        runMetrics,
        estimateTokens(completion.toolDefinitionChars),
        completion.toolDefinitionCount ?? 0,
      );
    }

    if (completion.toolsDisabled) {
      state.response = { ...state.response, toolsDisabled: true };
    }

    const assistantMessage = {
      role: "assistant" as const,
      content: completion.content,
      ...(completion.reasoningParts && completion.reasoningParts.length > 0
        ? { reasoning_parts: completion.reasoningParts }
        : {}),
      ...(completion.toolCalls
        ? {
            tool_calls: completion.toolCalls.map((tc) => ({
              id: tc.id,
              type: tc.type,
              function: { name: tc.function.name, arguments: tc.function.arguments },
              ...(tc.thought_signature ? { thought_signature: tc.thought_signature } : {}),
            })),
          }
        : {}),
    };

    state.currentMessages.push(assistantMessage);

    const trimUpdate = yield* runContextWindowManager.trim(
      state.currentMessages,
      logger,
      agent.id,
      actualConversationId,
    );
    state.currentMessages = trimUpdate.messages;
    if (trimUpdate.result !== undefined) {
      yield* logContextRung(logger, {
        rung: "trim",
        agentId: agent.id,
        conversationId: actualConversationId,
        tokensBefore: trimUpdate.result.estimatedTokensBefore,
        tokensAfter: trimUpdate.result.estimatedTokens,
        budgetTokens: runContextWindowManager.contextBudgetTokens,
        messagesBefore: trimUpdate.result.originalCount,
        messagesAfter: trimUpdate.result.trimmedCount,
      });
      if (!options.internal) {
        yield* observer.onHistoryTrimmed(agent.name, trimUpdate.result.messagesRemoved);
      }
    }

    if (completion.toolCalls && completion.toolCalls.length > 0) {
      const toolPhase = yield* handleToolPhase(
        state,
        completion.toolCalls,
        completion.content,
        iterationIndex,
        deps,
      );
      if (toolPhase === "interrupted") {
        return { kind: "interrupted" } as const;
      }
      return { kind: "continue" } as const;
    }

    // No tool calls - final response
    yield* logger.info("Agent provided final response", {
      agentId: agent.id,
      conversationId: actualConversationId,
      iteration: iterationIndex + 1,
      completionLength: completion.content.length,
      totalToolsUsed: runMetrics.toolCalls,
    });

    // If the model produced reasoning but no text content (e.g. llama.cpp
    // with --jinja routing the entire response into reasoning_content),
    // surface the reasoning as the visible content so downstream
    // consumers — conversation history, summarization, batch rendering —
    // see what the model actually said.
    const visibleContent = completion.content?.trim().length
      ? completion.content
      : (completion.reasoning ?? completion.content);
    state.response = {
      ...state.response,
      content: visibleContent,
      ...(completion.reasoning ? { reasoning: completion.reasoning } : {}),
      // Media the model itself returned, joining anything tools produced earlier in the run.
      ...(completion.artifacts && completion.artifacts.length > 0
        ? { artifacts: [...(state.response.artifacts ?? []), ...completion.artifacts] }
        : {}),
    };

    // Internal runs (compaction, other sub-agents) return content to the
    // parent. Presenting them as a finished turn makes the live conversation
    // look done and fires the "task complete" notification mid-work.
    if (!options.internal) {
      yield* strategy.presentResponse(agent.name, visibleContent, completion);
      yield* observer.onCompletion(agent.name);
      yield* strategy.onComplete(agent.name, completion);
    }

    state.iterationsUsed = iterationIndex + 1;
    return { kind: "final" } as const;
  });
}

/**
 * Shared agent execution loop used by both streaming and batch executors.
 *
 * Handles:
 * - Acquire/release pattern (logger session, MCP cleanup, finalize fiber)
 * - Main iteration loop with context compaction
 * - LLM request/response logging
 * - Token recording and toolsDisabled handling
 * - Assistant message construction and context trimming
 * - Tool execution and result validation
 * - Post-loop cleanup (iteration limit, empty response warnings)
 * - Finalization and metrics
 */
export function executeAgentLoop(
  options: AgentRunnerOptions,
  runContext: AgentRunContext,
  displayConfig: DisplayConfig,
  strategy: CompletionStrategy,
  observer: AgentLoopObserver,
  runRecursive: RecursiveRunner,
): Effect.Effect<
  AgentResponse,
  LLMRateLimitError | Error,
  | LLMService
  | ToolRegistry
  | LoggerService
  | AgentConfigService
  | PresentationService
  | ToolRequirements
> {
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const logger = yield* LoggerServiceTag;
      // The resolved id, not options.conversationId: a run started without one still gets
      // a conversation, and falling back to a constant here would pile every anonymous
      // run into a single shared log file.
      yield* logger.setLogGroup(
        conversationLogGroup(options.agent.id, runContext.actualConversationId),
      );
      const finalizeFiberRef = yield* Ref.make<Option.Option<Fiber.RuntimeFiber<void, Error>>>(
        Option.none(),
      );
      return { logger, finalizeFiberRef };
    }),
    // Use: main loop
    ({ logger, finalizeFiberRef }) =>
      Effect.gen(function* () {
        const { agent } = options;
        const {
          actualConversationId,
          context,
          tools,
          messages,
          runMetrics,
          provider,
          model,
          maxIterations,
          maxCostUSD,
          maxTokens,
          maxDurationMs,
        } = runContext;

        const configService = yield* AgentConfigServiceTag;
        const appConfig = yield* configService.appConfig;

        // Fetch model's actual context window from models.dev
        const modelMetadata = yield* Effect.tryPromise({
          try: () => getModelsDevMetadata(model, provider),
          catch: () => new Error("Failed to fetch model metadata"),
        }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));

        const effectiveContextWindow = resolveEffectiveContextWindow({
          provider,
          ...(modelMetadata && { modelMaxTokens: modelMetadata.contextWindow }),
          ...(typeof agent.config.numCtx === "number" && {
            pinnedContextWindow: agent.config.numCtx,
          }),
          ...(typeof agent.config.maxContextTokens === "number" && {
            agentMaxTokens: agent.config.maxContextTokens,
          }),
        });
        const contextWindowMaxTokens = effectiveContextWindow.tokens;

        // Trim is the floor, not the routine path: it discards messages instead of
        // summarizing them, so its budget sits above the compaction threshold. Keying
        // it to a constant below the window (it was 50k) made trimming pre-empt
        // compaction on every model with a window over ~62k — a sliding window in all
        // but name, and one that rewrote the cacheable prefix on every turn.
        const trimBudgetTokens = Math.floor(contextWindowMaxTokens * CONTEXT_TRIM_THRESHOLD_RATIO);
        const protectedRecentTurns =
          DEFAULT_CONTEXT_WINDOW_MANAGER.getConfig().protectedRecentTurns;
        const contextThresholds = resolveContextThresholds(appConfig.context);
        for (const thresholdWarning of contextThresholds.warnings) {
          yield* logger.warn(thresholdWarning, { agentId: agent.id });
        }
        const runContextWindowManager = new ContextWindowManager({
          maxTokens: trimBudgetTokens,
          contextBudgetTokens: contextWindowMaxTokens,
          ...(protectedRecentTurns !== undefined && { protectedRecentTurns }),
          warnThresholdRatio: contextThresholds.warnThresholdRatio,
          compactThresholdRatio: contextThresholds.compactThresholdRatio,
          modelHint: { provider, modelId: model },
        });

        yield* logger.debug("Using model context window", {
          model,
          provider,
          contextWindow: contextWindowMaxTokens,
          modelMaxTokens: effectiveContextWindow.modelMaxTokens,
          contextWindowSource: effectiveContextWindow.source,
          agentMaxTokens: effectiveContextWindow.agentMaxTokens,
          cappedByAgent: effectiveContextWindow.cappedByAgent,
        });

        const shortfall = describeContextWindowShortfall(provider, effectiveContextWindow);
        if (shortfall !== null && !options.internal) {
          yield* observer.onContextWindowUnknown(agent.name, shortfall);
        }

        const state: LoopState = {
          currentMessages: [messages[0], ...messages.slice(1)],
          response: {
            content: "",
            conversationId: actualConversationId,
          },
          recentToolCalls: [],
          iterationsUsed: 0,
          contextPressureWarned: false,
          toolResultsCleared: false,
        };
        let finished = false;
        let interrupted = false;
        let costCapped = false;
        let tokenCapped = false;
        let durationCapped = false;

        // models.dev reports input modalities; absence means text-only. Unlike tool support —
        // which defaults to available so an unknown model is not needlessly crippled — an
        // unknown model is assumed to have no media input, because sending an image to a
        // text-only model is a hard provider error rather than a worse answer.
        const supportedAttachmentKinds: AttachmentKind[] = [];
        if (modelMetadata?.ingestImage) supportedAttachmentKinds.push("image");
        if (modelMetadata?.ingestPdf) supportedAttachmentKinds.push("pdf");
        if (modelMetadata?.ingestAudio) supportedAttachmentKinds.push("audio");
        if (modelMetadata?.ingestVideo) supportedAttachmentKinds.push("video");

        const deps: LoopDeps = {
          agent,
          options,
          actualConversationId,
          context,
          tools,
          provider,
          model,
          runMetrics,
          contextWindowMaxTokens,
          runContextWindowManager,
          displayConfig,
          strategy,
          observer,
          logger,
          maxIterations,
          maxCostUSD,
          maxTokens,
          maxDurationMs,
          modelMetadata,
          runRecursive,
          supportedAttachmentKinds,
        };

        // A resumed run rejoins a turn that stopped between a tool call and its result.
        // Handing that transcript straight to the model would ask it to reason about a call
        // it never got an answer to, so the call is finished first — with the approval the
        // person just gave already in hand — and only then does the loop start.
        if (options.pendingToolCalls !== undefined && options.pendingToolCalls.length > 0) {
          yield* Effect.sync(() => beginIteration(runMetrics, 1));
          const pendingPhase = yield* handleToolPhase(
            state,
            [...options.pendingToolCalls],
            "",
            0,
            deps,
          );
          if (pendingPhase === "interrupted") {
            finished = true;
            interrupted = true;
          }
        }

        for (let i = 0; i < maxIterations && !interrupted; i++) {
          yield* Effect.sync(() => beginIteration(runMetrics, i + 1));
          try {
            const step = yield* runIteration(state, i, deps);
            if (step.kind === "interrupted") {
              finished = true;
              interrupted = true;
              break;
            }
            if (step.kind === "final") {
              finished = true;
              break;
            }
          } finally {
            yield* Effect.sync(() => completeIteration(runMetrics));
          }

          // Soft checkpoint, not a preemptive interrupt: checked once between
          // iterations, same timing as the iteration budget above. A single
          // expensive iteration (including a whole sub-agent delegation) can push
          // the total past maxCostUSD before this trips — see docs/internals/agent-loop.md.
          // Never guess-abort on unpriced usage (a local model, say): costUSD is
          // only defined once spend is actually known.
          if (maxCostUSD !== undefined) {
            const runCost = computeRunCost(runMetrics, modelMetadata);
            if (runCost.costUSD !== undefined && runCost.costUSD >= maxCostUSD) {
              costCapped = true;
              state.iterationsUsed = i + 1;
              yield* observer.onCostCapReached(agent.name, maxCostUSD, runCost.costUSD);
              break;
            }
          }

          // Same soft-checkpoint timing as maxCostUSD, but needs no pricing lookup —
          // this still enforces on an unpriced/local model where the cost cap cannot fire.
          if (maxTokens !== undefined) {
            const totalTokens = runMetrics.totalPromptTokens + runMetrics.totalCompletionTokens;
            if (totalTokens >= maxTokens) {
              tokenCapped = true;
              state.iterationsUsed = i + 1;
              yield* observer.onTokenCapReached(agent.name, maxTokens, totalTokens);
              break;
            }
          }

          // Same soft-checkpoint timing as maxCostUSD/maxTokens. The 50/80/90% pressure
          // nudges are injected per-iteration inside runIteration (see buildTimeBudgetPressureMessage);
          // this is the hard stop once the budget is actually exhausted.
          if (maxDurationMs !== undefined) {
            const elapsedMs = Date.now() - runMetrics.startedAt.getTime();
            if (elapsedMs >= maxDurationMs) {
              durationCapped = true;
              state.iterationsUsed = i + 1;
              yield* observer.onDurationCapReached(agent.name, maxDurationMs, elapsedMs);
              break;
            }
          }
        }

        return yield* finalizeRun(
          {
            response: state.response,
            currentMessages: state.currentMessages,
            runMetrics,
            modelMetadata,
            iterationsUsed: state.iterationsUsed,
            finished,
            interrupted,
            costCapped,
            tokenCapped,
            durationCapped,
          },
          observer,
          logger,
          agent.name,
          maxIterations,
          finalizeFiberRef,
        );
      }).pipe(
        // A run that dies here never reaches finalizeRun, so `agent_run_completed`
        // is never emitted. Record the failure instead. Interrupts (Ctrl+C, double
        // Esc) are not failures and are left unrecorded.
        Effect.tapErrorCause((cause) =>
          Cause.isInterruptedOnly(cause)
            ? Effect.void
            : emitAgentRunFailed(
                runContext.runMetrics,
                Cause.failureOption(cause).pipe(Option.getOrElse(() => Cause.pretty(cause))),
              ),
        ),
      ),
    // Release: cleanup
    ({ logger, finalizeFiberRef }) =>
      Effect.gen(function* () {
        const fiberOption = yield* Ref.get(finalizeFiberRef);
        if (Option.isSome(fiberOption)) {
          yield* Fiber.await(fiberOption.value).pipe(
            Effect.asVoid,
            Effect.catchAll(() => Effect.void),
          );
        }

        yield* logger.clearLogGroup();
      }),
  );
}
