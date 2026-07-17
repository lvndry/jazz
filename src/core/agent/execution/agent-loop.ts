import { Effect, Fiber, Option, Ref } from "effect";
import { DEFAULT_MAX_ITERATIONS } from "@/core/constants/agent";
import { DEFAULT_CONTEXT_WINDOW } from "@/core/constants/models";
import { type AgentConfigService } from "@/core/interfaces/agent-config";
import type { LLMService } from "@/core/interfaces/llm";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import type { PresentationService, StreamingRenderer } from "@/core/interfaces/presentation";
import type { ToolRegistry, ToolRequirements } from "@/core/interfaces/tool-registry";
import type { ChatMessage, ConversationMessages } from "@/core/types";
import type { ChatCompletionResponse } from "@/core/types/chat";
import { LLMRateLimitError } from "@/core/types/errors";
import type { DisplayConfig } from "@/core/types/output";
import { getModelsDevMetadata } from "@/core/utils/models-dev-client";
import { formatToolResultForContext } from "@/core/utils/tool-result-formatter";
import type { AgentLoopObserver } from "./agent-loop-observer";
import { ToolExecutor } from "./tool-executor";
import {
  ContextWindowManager,
  DEFAULT_CONTEXT_WINDOW_MANAGER,
} from "../context/context-window-manager";
import { Summarizer, type RecursiveRunner } from "../context/summarizer";
import {
  beginIteration,
  calibrateTokenCounter,
  completeIteration,
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

export interface TrackedToolCall {
  name: string;
  arguments: string;
}

interface LoopState {
  currentMessages: ConversationMessages;
  response: AgentResponse;
  recentToolCalls: TrackedToolCall[];
  iterationsUsed: number;
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
  runRecursive: RecursiveRunner;
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
   * Whether to show thinking indicators for this strategy.
   */
  shouldShowThinking: boolean;
}

interface FinalizeInput {
  response: AgentResponse;
  currentMessages: ConversationMessages;
  runMetrics: AgentRunMetrics;
  modelMetadata: { inputPricePerMillion?: number; outputPricePerMillion?: number } | undefined;
  iterationsUsed: number;
  finished: boolean;
  interrupted: boolean;
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
    const { response, currentMessages, runMetrics, modelMetadata, finished, interrupted } = input;
    let iterationsUsed = input.iterationsUsed;

    if (!finished) {
      iterationsUsed = maxIterations;
      yield* observer.onIterationLimit(agentName, maxIterations);
    } else if (
      !response.content?.trim() &&
      !response.reasoning?.trim() &&
      !response.toolCalls &&
      !interrupted
    ) {
      yield* observer.onEmptyResponse(agentName);
    }

    yield* logger.debug("Finalizing agent run", { interrupted, finished });

    const finalizeFiber = yield* finalizeAgentRun(runMetrics, {
      iterationsUsed,
      finished,
    }).pipe(
      Effect.catchAll((error) =>
        logger.warn("Failed to write agent token usage log", { error: error.message }),
      ),
      Effect.fork,
    );
    yield* Ref.set(finalizeFiberRef, Option.some(finalizeFiber));

    const inputPrice = modelMetadata?.inputPricePerMillion ?? 0;
    const outputPrice = modelMetadata?.outputPricePerMillion ?? 0;
    const costUSD =
      inputPrice > 0 || outputPrice > 0
        ? parseFloat(
            (
              (runMetrics.totalPromptTokens / 1_000_000) * inputPrice +
              (runMetrics.totalCompletionTokens / 1_000_000) * outputPrice
            ).toFixed(8),
          )
        : undefined;

    return {
      ...response,
      messages: currentMessages,
      usage: {
        promptTokens: runMetrics.totalPromptTokens,
        completionTokens: runMetrics.totalCompletionTokens,
      },
      ...(costUSD !== undefined ? { costUSD } : {}),
    };
  });
}

/**
 * Handles the tool-call branch of a single loop iteration: executes the tool
 * calls, validates every call produced a result, appends tool-result messages,
 * runs meltdown detection/recovery injection, and applies budget/queued-message
 * handling. Mutates `state` in place (currentMessages, recentToolCalls, response).
 */
function handleToolPhase(
  state: LoopState,
  toolCalls: NonNullable<ChatCompletionResponse["toolCalls"]>,
  reasoningContent: string,
  iterationIndex: number,
  deps: LoopDeps,
): Effect.Effect<
  void,
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
    maxIterations,
    options,
    logger,
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

    const contextWithTokenStats = {
      ...context,
      tokenStats: {
        currentTokens: runContextWindowManager.calculateTotalTokens(state.currentMessages),
        maxTokens: contextWindowMaxTokens,
      },
      conversationMessages: state.currentMessages,
      parentAgent: agent,
      parentMaxIterations: maxIterations,
      compactConversation: (compacted: readonly ChatMessage[]) => {
        state.currentMessages = [
          state.currentMessages[0],
          ...compacted.slice(1),
        ] as typeof state.currentMessages;
      },
    };

    const toolResults = yield* ToolExecutor.executeToolCalls(
      toolCalls,
      contextWithTokenStats,
      displayConfig,
      strategy.getRenderer(),
      runMetrics,
      agent.id,
      actualConversationId,
      agent.name,
      strategy.getInterruptSignal?.(),
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

    state.response = {
      ...state.response,
      toolCalls: [...(state.response.toolCalls ?? []), ...toolCalls],
      toolResults: {
        ...state.response.toolResults,
        ...Object.fromEntries(toolResults.map((r) => [r.name, r.result])),
      },
    };

    const queuedMessage = options.checkQueuedMessage?.();
    if (queuedMessage) {
      state.currentMessages.push({ role: "user", content: queuedMessage });
    }
  });
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
    runRecursive,
  } = deps;

  return Effect.gen(function* () {
    if (!options.internal && strategy.shouldShowThinking) {
      yield* observer.onThinking(agent.name, iterationIndex === 0);
    }

    state.currentMessages = yield* Summarizer.compactIfNeeded(
      state.currentMessages,
      agent,
      options.sessionId,
      actualConversationId,
      runRecursive,
      contextWindowMaxTokens,
    );

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

    const budgetMsg = buildBudgetPressureMessage(iterationIndex + 1, maxIterations);
    const messagesForLLM = budgetMsg
      ? ([...state.currentMessages, budgetMsg] as typeof state.currentMessages)
      : state.currentMessages;

    const result = yield* strategy.getCompletion(messagesForLLM, iterationIndex);

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

    if (completion.toolCalls && completion.toolCalls.length > 0) {
      yield* handleToolPhase(state, completion.toolCalls, completion.content, iterationIndex, deps);
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
    };

    // Let strategy present the response (batch renders markdown, streaming is already rendered)
    yield* strategy.presentResponse(agent.name, visibleContent, completion);
    yield* observer.onCompletion(agent.name);
    yield* strategy.onComplete(agent.name, completion);

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
      yield* logger.setSessionId(options.sessionId);
      const finalizeFiberRef = yield* Ref.make<Option.Option<Fiber.RuntimeFiber<void, Error>>>(
        Option.none(),
      );
      return { logger, finalizeFiberRef };
    }),
    // Use: main loop
    ({ logger, finalizeFiberRef }) =>
      Effect.gen(function* () {
        const { agent, maxIterations: maxIter } = options;
        const maxIterations = maxIter ?? DEFAULT_MAX_ITERATIONS;
        const { actualConversationId, context, tools, messages, runMetrics, provider, model } =
          runContext;

        // Fetch model's actual context window from models.dev
        const modelMetadata = yield* Effect.tryPromise({
          try: () => getModelsDevMetadata(model, provider),
          catch: () => new Error("Failed to fetch model metadata"),
        }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));

        const contextWindowMaxTokens = modelMetadata?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;

        const trimBudgetTokens = DEFAULT_CONTEXT_WINDOW_MANAGER.getConfig().maxTokens;
        const protectedRecentTurns =
          DEFAULT_CONTEXT_WINDOW_MANAGER.getConfig().protectedRecentTurns;
        const runContextWindowManager = new ContextWindowManager({
          maxTokens: trimBudgetTokens,
          ...(protectedRecentTurns !== undefined && { protectedRecentTurns }),
          modelHint: { provider, modelId: model },
        });

        yield* logger.debug("Using model context window", {
          model,
          provider,
          contextWindow: contextWindowMaxTokens,
          source: modelMetadata ? "models.dev" : "default",
        });

        const state: LoopState = {
          currentMessages: [messages[0], ...messages.slice(1)],
          response: {
            content: "",
            conversationId: actualConversationId,
          },
          recentToolCalls: [],
          iterationsUsed: 0,
        };
        let finished = false;
        let interrupted = false;

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
          runRecursive,
        };

        for (let i = 0; i < maxIterations; i++) {
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
          },
          observer,
          logger,
          agent.name,
          maxIterations,
          finalizeFiberRef,
        );
      }),
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

        yield* logger.clearSessionId();
      }),
  );
}
