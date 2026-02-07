import { Cause, Deferred, Duration, Effect, Exit, Fiber, Option, Ref, Schedule, Stream } from "effect";
import type { AgentConfigService } from "@/core/interfaces/agent-config";
import { LLMServiceTag, type LLMService } from "@/core/interfaces/llm";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import { NotificationServiceTag } from "@/core/interfaces/notification";
import type { PresentationService } from "@/core/interfaces/presentation";
import { PresentationServiceTag } from "@/core/interfaces/presentation";
import type { ToolRegistry, ToolRequirements } from "@/core/interfaces/tool-registry";
import type { StreamEvent, StreamingConfig } from "@/core/types";
import { type ChatCompletionResponse } from "@/core/types/chat";
import { type LLMError, LLMAuthenticationError, LLMRateLimitError, LLMRequestError } from "@/core/types/errors";
import type { DisplayConfig } from "@/core/types/output";
import type { RecursiveRunner } from "../context/summarizer";
import {
  recordFirstTokenLatency,
  recordLLMRetry,
} from "../metrics/agent-run-metrics";
import type { AgentResponse, AgentRunContext, AgentRunnerOptions } from "../types";
import { executeAgentLoop, type CompletionStrategy } from "./agent-loop";

const MAX_RETRIES = 3;
const STREAM_CREATION_TIMEOUT = Duration.minutes(2);
const DEFERRED_RESPONSE_TIMEOUT = Duration.seconds(15);

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
      reasoningEffort: agent.config.reasoningEffort,
    });

    // Create interruption signal
    const interruptDeferred = yield* Deferred.make<void>();
    const onInterrupt = () => {
      Effect.runSync(Deferred.succeed(interruptDeferred, void 0));
    };
    yield* renderer.setInterruptHandler(onInterrupt);

    // Ref to capture partial completion from stream events — hoisted to avoid per-iteration allocation
    const completionRef = yield* Ref.make<ChatCompletionResponse | undefined>(undefined);

    const strategy: CompletionStrategy = {
      shouldShowThinking: true,

      getCompletion(currentMessages, _iteration) {
        return Effect.gen(function* () {
          // Reset for this iteration
          yield* Ref.set(completionRef, undefined);

          const llmOptions = {
            model,
            messages: currentMessages,
            tools: runContext.tools,
            toolChoice: "auto" as const,
            reasoning_effort: agent.config.reasoningEffort ?? "disable",
          };

          const streamingResult = yield* Effect.retry(
            Effect.gen(function* () {
              try {
                return yield* llmService.createStreamingChatCompletion(provider, llmOptions);
              } catch (error) {
                recordLLMRetry(runMetrics, error);
                if (
                  error instanceof LLMRequestError ||
                  error instanceof LLMRateLimitError ||
                  error instanceof LLMAuthenticationError
                ) {
                  yield* logger.error("LLM request error", {
                    provider,
                    model: agent.config.llmModel,
                    errorType: error._tag,
                    message: error.message,
                    agentId: agent.id,
                    conversationId: actualConversationId,
                  });
                }
                throw error;
              }
            }),
            Schedule.exponential("1 second").pipe(
              Schedule.intersect(Schedule.recurs(MAX_RETRIES)),
              Schedule.whileInput((error) => error instanceof LLMRateLimitError),
            ),
          ).pipe(
            Effect.timeout(STREAM_CREATION_TIMEOUT),
            Effect.catchAll((error) =>
              Effect.gen(function* () {
                if (
                  error instanceof LLMRequestError ||
                  error instanceof LLMRateLimitError ||
                  error instanceof LLMAuthenticationError
                ) {
                  yield* logger.warn("Streaming failed, falling back to non-streaming mode", {
                    provider,
                    model: agent.config.llmModel,
                    errorType: error._tag,
                    message: error.message,
                    agentId: agent.id,
                    conversationId: actualConversationId,
                  });
                } else {
                  yield* logger.warn("Streaming failed, falling back to non-streaming mode", {
                    provider,
                    model: agent.config.llmModel,
                    error: error instanceof Error ? error.message : String(error),
                    agentId: agent.id,
                    conversationId: actualConversationId,
                  });
                }
                const fallback = yield* llmService.createChatCompletion(provider, llmOptions);
                return {
                  stream: Stream.empty,
                  response: Effect.succeed(fallback),
                  cancel: Effect.void,
                };
              }),
            ),
          );

          // Process stream events
          const streamFiber = yield* Effect.fork(
            Stream.runForEach(streamingResult.stream, (event: StreamEvent) =>
              Effect.gen(function* () {
                yield* renderer.handleEvent(event);
                if (event.type === "complete") {
                  yield* Ref.set(completionRef, event.response);
                  if (event.metrics?.firstTokenLatencyMs) {
                    recordFirstTokenLatency(runMetrics, event.metrics.firstTokenLatencyMs);
                  }
                }
                if (event.type === "error") {
                  const error = event.error as
                    | LLMAuthenticationError
                    | LLMRateLimitError
                    | LLMRequestError;
                  yield* logger.error("Stream event error", {
                    provider,
                    model: agent.config.llmModel,
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

          // Wait for stream completion or interruption
          const streamExit = yield* Fiber.await(streamFiber).pipe(
            Effect.raceFirst(Deferred.await(interruptDeferred)),
          );

          const isInterrupted = yield* Deferred.isDone(interruptDeferred);

          if (isInterrupted) {
            yield* streamingResult.cancel.pipe(
              Effect.catchAll((e) =>
                logger.debug(`Stream cancel error (safe to ignore): ${String(e)}`),
              ),
            );
            yield* Fiber.interrupt(streamFiber).pipe(
              Effect.catchAll((e) =>
                logger.debug(`Fiber interrupt error (safe to ignore): ${String(e)}`),
              ),
            );
            yield* renderer.reset().pipe(
              Effect.catchAll((e) =>
                logger.debug(`Renderer reset error (safe to ignore): ${String(e)}`),
              ),
            );

            const fromRef = yield* Ref.get(completionRef);
            const partialCompletion: ChatCompletionResponse = fromRef ?? {
              id: "interrupted",
              model,
              content: "",
            };
            return { completion: partialCompletion, interrupted: true };
          }

          let completion: ChatCompletionResponse;
          const exit = streamExit as Exit.Exit<void, LLMError>;

          if (Exit.isFailure(exit)) {
            yield* streamingResult.cancel;
            const errorOption = Cause.failureOption(exit.cause);
            if (Option.isSome(errorOption)) {
              yield* logger.error("Stream processing failed", {
                error:
                  errorOption.value instanceof Error
                    ? errorOption.value.message
                    : String(errorOption.value),
              });
              return yield* Effect.fail(errorOption.value);
            } else {
              const defectOption = Cause.dieOption(exit.cause);
              if (Option.isSome(defectOption)) {
                return yield* Effect.die(defectOption.value);
              }
              const fromRef = yield* Ref.get(completionRef);
              if (fromRef) {
                completion = fromRef;
              } else {
                completion = yield* streamingResult.response.pipe(
                  Effect.timeout(DEFERRED_RESPONSE_TIMEOUT),
                  Effect.catchAll(() =>
                    Effect.gen(function* () {
                      yield* streamingResult.cancel;
                      return yield* llmService.createChatCompletion(provider, llmOptions);
                    }),
                  ),
                );
              }
            }
          } else {
            const fromRef = yield* Ref.get(completionRef);
            if (fromRef) {
              completion = fromRef;
            } else {
              completion = yield* streamingResult.response.pipe(
                Effect.timeout(DEFERRED_RESPONSE_TIMEOUT),
                Effect.catchAll(() =>
                  Effect.gen(function* () {
                    yield* streamingResult.cancel;
                    return yield* llmService.createChatCompletion(provider, llmOptions);
                  }),
                ),
              );
            }
          }

          return { completion, interrupted: false };
        });
      },

      presentResponse(_agentName, _content, _completion) {
        // Streaming mode: response is already rendered by the stream handler
        return Effect.void;
      },

      onComplete(agentName, _completion) {
        return Effect.gen(function* () {
          if (Option.isSome(notificationServiceOption)) {
            yield* notificationServiceOption.value
              .notify(`${agentName} has completed the task.`, {
                title: "Jazz Task Complete",
                sound: true,
              })
              .pipe(Effect.catchAll(() => Effect.void));
          }
        });
      },

      getRenderer() {
        return renderer;
      },
    };

    return yield* executeAgentLoop(options, runContext, displayConfig, strategy, runRecursive);
  });
}
