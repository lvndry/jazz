import { Cause, Deferred, Duration, Effect, Exit, Fiber, Option, Queue, Ref, Stream } from "effect";
import {
  makeUserVisibleLlmRetrySchedule,
  withLongRunningLlmNotice,
} from "@/core/agent/execution/llm-retry-present";
import { isEmptyCompletion, judgeAnswer } from "@/core/agent/run/answer-outcome";
import { DEFAULT_MAX_LLM_RETRIES, LLM_TIMEOUT_SECONDS } from "@/core/constants/agent";
import type { AgentConfigService } from "@/core/interfaces/agent-config";
import { LLMServiceTag, type LLMService } from "@/core/interfaces/llm";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import { NotificationServiceTag } from "@/core/interfaces/notification";
import type { PresentationService } from "@/core/interfaces/presentation";
import { PresentationServiceTag } from "@/core/interfaces/presentation";
import type { ToolRegistry, ToolRequirements } from "@/core/interfaces/tool-registry";
import type { StreamEvent, StreamingConfig } from "@/core/types";
import { type ChatCompletionResponse } from "@/core/types/chat";
import { LLMAuthenticationError, LLMRateLimitError, LLMRequestError } from "@/core/types/errors";
import { describeReasoningSelection, reasoningIsEnabled } from "@/core/types/model-capabilities";
import type { DisplayConfig } from "@/core/types/output";
import { isRetryableLLMError } from "@/core/utils/llm-error";
import { executeAgentLoop, type CompletionStrategy } from "./agent-loop";
import { makeDefaultObserver } from "./agent-loop-observer";
import type { RecursiveRunner } from "../context/summarizer";
import {
  emitLLMRetry,
  recordFirstTokenLatency,
  recordLLMRetry,
} from "../metrics/agent-run-metrics";
import type { AgentResponse, AgentRunContext, AgentRunnerOptions } from "../types";

const DEFERRED_RESPONSE_TIMEOUT = Duration.seconds(15);

/**
 * Transient streaming failures in one step before its remaining attempts switch to a plain
 * request. More than one, because a single dropped stream is usually just a network blip;
 * few enough that a provider whose streaming is broken still gets answered well inside the
 * retry budget.
 */
const STREAMING_FAILURES_BEFORE_FALLBACK = 3;

/**
 * Streaming implementation that processes LLM responses in real-time.
 */
export function executeWithStreaming(
  options: AgentRunnerOptions,
  runContext: AgentRunContext,
  displayConfig: DisplayConfig,
  streamingConfig: StreamingConfig,
  showMetrics: boolean,
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
  return Effect.gen(function* () {
    const llmService = yield* LLMServiceTag;
    const logger = yield* LoggerServiceTag;
    const presentationService = yield* PresentationServiceTag;
    const notificationServiceOption = yield* Effect.serviceOption(NotificationServiceTag);
    const { agent } = options;
    const { runMetrics, provider, model, actualConversationId } = runContext;
    const maxRetries = runContext.maxRetries ?? DEFAULT_MAX_LLM_RETRIES;

    const reasoning = agent.config.llm.reasoning;
    const reasoningLabel = describeReasoningSelection(reasoning);
    const shouldShowReasoning = displayConfig.showReasoning && reasoningIsEnabled(reasoning);

    // Create renderer
    const normalizedStreamingConfig: StreamingConfig = {
      enabled: true,
      ...(streamingConfig.textBufferMs !== undefined && {
        textBufferMs: streamingConfig.textBufferMs,
      }),
    };

    const renderer = yield* presentationService.createStreamingRenderer({
      displayConfig,
      streamingConfig: normalizedStreamingConfig,
      showMetrics,
      agentName: agent.name,
      reasoning: reasoningLabel,
      ...(options.ephemeralRegionId !== undefined && {
        streamTarget: { kind: "ephemeral", regionId: options.ephemeralRegionId },
      }),
    });

    // Create interruption signal
    const interruptDeferred = yield* Deferred.make<void>();
    const onInterrupt = () => {
      Effect.runSync(Deferred.succeed(interruptDeferred, void 0));
    };
    yield* renderer.setInterruptHandler(onInterrupt);

    // Ctrl+B ("background") signal: unlike interruptDeferred, a Deferred can only ever
    // resolve once, but this run may go through many tool batches and each one needs its
    // own chance to be backgrounded — so this is a queue of "detach whatever's running
    // right now" requests, one per keypress, rather than a one-shot signal. Stale entries
    // from a batch that already finished by the time the next one starts are drained away
    // before each race so a leftover press never backgrounds the wrong batch.
    const backgroundQueue = yield* Queue.unbounded<void>();
    const onBackground = () => {
      Effect.runSync(Queue.offer(backgroundQueue, void 0));
    };
    yield* renderer.setBackgroundHandler?.(onBackground) ?? Effect.void;

    // Ref to capture partial completion from stream events — hoisted to avoid per-iteration allocation
    const completionRef = yield* Ref.make<ChatCompletionResponse | undefined>(undefined);
    // Ref to accumulate streamed text so interruption can capture partial output
    const textAccumulatorRef = yield* Ref.make<string>("");

    const strategy: CompletionStrategy = {
      shouldShowReasoning,

      getCompletion(currentMessages, _iteration, toolsAllowed) {
        return Effect.gen(function* () {
          // Reset for this iteration
          yield* Ref.set(completionRef, undefined);
          yield* Ref.set(textAccumulatorRef, "");

          const llmOptions = {
            model,
            messages: currentMessages,
            tools: runContext.tools,
            toolChoice: toolsAllowed ? ("auto" as const) : ("none" as const),
            ...(reasoning !== undefined ? { reasoning } : {}),
            ...(typeof agent.config.llm.temperature === "number"
              ? { temperature: agent.config.llm.temperature }
              : {}),
            ...(typeof agent.config.llm.numCtx === "number"
              ? { num_ctx: agent.config.llm.numCtx }
              : {}),
            ...(agent.config.llm.apiKeys ? { providerApiKeys: agent.config.llm.apiKeys } : {}),
          };

          const showAgentStatus = (
            message: string,
            level: "info" | "success" | "warning" | "error" | "progress",
          ) => presentationService.presentStatus(message, level, agent.name);

          const retryAttemptRef = yield* Ref.make(0);
          const streamingFailuresRef = yield* Ref.make(0);
          const retrySchedule = makeUserVisibleLlmRetrySchedule(
            maxRetries,
            agent.name,
            showAgentStatus,
            retryAttemptRef,
            presentationService.presentRetry,
          );

          const streamingAttempt = Effect.gen(function* () {
            yield* Ref.set(completionRef, undefined);
            yield* Ref.set(textAccumulatorRef, "");

            const streamingResult = yield* llmService.createStreamingChatCompletion(
              provider,
              llmOptions,
            );
            const streamFiber = yield* Effect.fork(
              Stream.runForEach(streamingResult.stream, (event: StreamEvent) =>
                Effect.gen(function* () {
                  yield* renderer.handleEvent(event);
                  if (event.type === "text_chunk") {
                    yield* Ref.set(textAccumulatorRef, event.accumulated);
                  }
                  if (event.type === "complete") {
                    yield* Ref.set(completionRef, event.response);
                    if (event.metrics?.firstTokenLatencyMs) {
                      recordFirstTokenLatency(runMetrics, event.metrics.firstTokenLatencyMs);
                    }
                  }
                  if (event.type === "error") {
                    const error = event.error as
                      LLMAuthenticationError | LLMRateLimitError | LLMRequestError;
                    yield* logger.error("Stream event error", {
                      provider,
                      model: agent.config.llm.model,
                      errorType: error._tag,
                      message: error.message,
                      recoverable: event.recoverable,
                      agentId: agent.id,
                      conversationId: actualConversationId,
                    });
                    if (!event.recoverable) {
                      yield* streamingResult.cancel;
                    }
                  }
                }),
              ),
            );

            const exit = yield* Fiber.await(streamFiber);
            if (Exit.isFailure(exit)) {
              yield* streamingResult.cancel;
              const errorOption = Cause.failureOption(exit.cause);
              if (Option.isSome(errorOption)) {
                return yield* Effect.fail(errorOption.value);
              }
              const defectOption = Cause.dieOption(exit.cause);
              if (Option.isSome(defectOption)) {
                return yield* Effect.die(defectOption.value);
              }
            }

            const fromRef = yield* Ref.get(completionRef);
            const completion = yield* streamingResult.response.pipe(
              Effect.timeout(DEFERRED_RESPONSE_TIMEOUT),
              Effect.catchAll(() =>
                fromRef
                  ? Effect.succeed(fromRef)
                  : Effect.gen(function* () {
                      yield* streamingResult.cancel;
                      return yield* llmService.createChatCompletion(provider, llmOptions);
                    }),
              ),
            );
            return { completion, interrupted: false };
          }).pipe(
            Effect.tapError((error) =>
              Effect.gen(function* () {
                recordLLMRetry(runMetrics, error);
                yield* emitLLMRetry(runMetrics, error);
                if (isRetryableLLMError(error)) {
                  yield* renderer.reset();
                }
                if (
                  error instanceof LLMRequestError ||
                  error instanceof LLMRateLimitError ||
                  error instanceof LLMAuthenticationError
                ) {
                  yield* logger.error("LLM request error", {
                    provider,
                    model: agent.config.llm.model,
                    errorType: error._tag,
                    message: error.message,
                    agentId: agent.id,
                    conversationId: actualConversationId,
                  });
                }
              }),
            ),
          );

          const nonStreamingAttempt = Effect.suspend(() =>
            llmService.createChatCompletion(provider, llmOptions),
          ).pipe(
            Effect.map((completion) => ({ completion, interrupted: false })),
            Effect.tapError((error) =>
              Effect.gen(function* () {
                recordLLMRetry(runMetrics, error);
                yield* emitLLMRetry(runMetrics, error);
              }),
            ),
          );

          /**
           * One attempt of the shared retry loop. After STREAMING_FAILURES_BEFORE_FALLBACK
           * transient streaming failures the remaining attempts go non-streaming, which
           * survives the stalls and dropped streams a plain request does not have. A 429
           * never counts toward that: a rate limit applies to both modes alike.
           */
          const attempt = Effect.gen(function* () {
            const streamingFailures = yield* Ref.get(streamingFailuresRef);
            if (streamingFailures >= STREAMING_FAILURES_BEFORE_FALLBACK) {
              return yield* nonStreamingAttempt;
            }
            return yield* streamingAttempt.pipe(
              Effect.tapError((error) =>
                isRetryableLLMError(error) && !(error instanceof LLMRateLimitError)
                  ? Ref.updateAndGet(streamingFailuresRef, (count) => count + 1).pipe(
                      Effect.flatMap((count) =>
                        count === STREAMING_FAILURES_BEFORE_FALLBACK
                          ? logger.warn("Streaming failed, falling back to non-streaming mode", {
                              provider,
                              model: agent.config.llm.model,
                              errorType: error._tag,
                              message: error.message,
                              agentId: agent.id,
                              conversationId: actualConversationId,
                            })
                          : Effect.void,
                      ),
                    )
                  : Effect.void,
              ),
            );
          });

          // One retry budget and one wall-clock limit for the whole step, whichever mode
          // each attempt uses.
          const completionWithRetries = Effect.retry(
            withLongRunningLlmNotice(agent.name, showAgentStatus, attempt),
            retrySchedule,
          ).pipe(
            Effect.timeout(Duration.seconds(LLM_TIMEOUT_SECONDS)),
            Effect.tapError((error) =>
              Cause.isTimeoutException(error)
                ? showAgentStatus(
                    `${agent.name} exceeded the maximum wait time for this step (including retries). Check connectivity or try again.`,
                    "warning",
                  )
                : Effect.void,
            ),
          );

          /**
           * What the model had produced when Esc landed. The losing completion is
           * interrupted by the race, which aborts its provider request through the
           * stream's finalizer, whether it was streaming, sleeping between retries, or
           * waiting on the non-streaming fallback.
           */
          const interruptedCompletion = Effect.gen(function* () {
            yield* renderer
              .flush()
              .pipe(
                Effect.catchAll(() =>
                  logger.debug("Renderer flush failed", { errorType: "renderer_flush_failed" }),
                ),
              );
            const accumulatedText = yield* Ref.get(textAccumulatorRef);
            const fromRef = yield* Ref.get(completionRef);
            const partialCompletion: ChatCompletionResponse = fromRef ?? {
              id: "interrupted",
              model,
              content: accumulatedText,
            };
            return { completion: partialCompletion, interrupted: true };
          });

          return yield* Effect.raceFirst(
            completionWithRetries,
            Deferred.await(interruptDeferred).pipe(Effect.zipRight(interruptedCompletion)),
          );
        });
      },

      presentResponse(_agentName, _content, _completion) {
        // Streaming mode: response is already rendered by the stream handler
        return Effect.void;
      },

      onComplete(agentName, completion) {
        return Effect.gen(function* () {
          if (Option.isSome(notificationServiceOption)) {
            const verdict = judgeAnswer({
              content: completion.content,
              ...(completion.artifacts ? { artifacts: completion.artifacts } : {}),
              ...(completion.finishReason ? { finishReason: completion.finishReason } : {}),
              emptyCompletion: isEmptyCompletion(completion.content, completion.usage),
            });
            const notice =
              verdict.kind === "failed"
                ? {
                    message: `${agentName} finished without an answer. ${verdict.message}`,
                    title: "Jazz Task Failed",
                  }
                : { message: `${agentName} has completed the task.`, title: "Jazz Task Complete" };
            yield* notificationServiceOption.value
              .notify(notice.message, { title: notice.title, sound: true })
              .pipe(Effect.catchAll(() => Effect.void));
          }
        });
      },

      getRenderer() {
        return renderer;
      },

      getInterruptSignal() {
        return Deferred.await(interruptDeferred);
      },

      getBackgroundSignal() {
        return Effect.gen(function* () {
          // Discard any press that arrived while nothing was racing this queue (between
          // batches, or held over from a batch that resolved on its own first) — only a
          // press that lands while this specific race is live should count.
          yield* Queue.takeAll(backgroundQueue);
          yield* Queue.take(backgroundQueue);
        });
      },
    };

    const observer = makeDefaultObserver(presentationService);
    const response = yield* executeAgentLoop(
      options,
      runContext,
      displayConfig,
      strategy,
      observer,
      runRecursive,
    ).pipe(
      Effect.tapError(() => renderer.reset()),
      Effect.ensuring(renderer.setInterruptHandler(null)),
      Effect.ensuring(renderer.setBackgroundHandler?.(null) ?? Effect.void),
    );

    return response;
  });
}
