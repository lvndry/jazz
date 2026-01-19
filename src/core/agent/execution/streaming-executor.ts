import { Cause, Duration, Effect, Exit, Fiber, Option, Ref, Schedule, Stream } from "effect";

import { MAX_AGENT_STEPS } from "@/core/constants/agent";
import { type AgentConfigService } from "@/core/interfaces/agent-config";
import { LLMServiceTag, type LLMService } from "@/core/interfaces/llm";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import { MCPServerManagerTag } from "@/core/interfaces/mcp-server";
import type { PresentationService } from "@/core/interfaces/presentation";
import { PresentationServiceTag } from "@/core/interfaces/presentation";
import type { ToolRegistry, ToolRequirements } from "@/core/interfaces/tool-registry";
import type { ConversationMessages, StreamEvent, StreamingConfig } from "@/core/types";
import { type ChatCompletionResponse } from "@/core/types/chat";
import { LLMAuthenticationError, LLMRateLimitError, LLMRequestError } from "@/core/types/errors";
import type { DisplayConfig } from "@/core/types/output";
import { DEFAULT_CONTEXT_WINDOW_MANAGER } from "../context/context-window-manager";
import { Summarizer, type RecursiveRunner } from "../context/summarizer";
import {
  beginIteration,
  completeIteration,
  finalizeAgentRun,
  recordFirstTokenLatency,
  recordLLMRetry,
  recordLLMUsage,
} from "../metrics/agent-run-metrics";
import type { AgentResponse, AgentRunContext, AgentRunnerOptions } from "../types";
import { ToolExecutor } from "./tool-executor";

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
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const logger = yield* LoggerServiceTag;
      const mcpManager = yield* Effect.serviceOption(MCPServerManagerTag);

      yield* logger.setSessionId(options.sessionId);

      const finalizeFiberRef = yield* Ref.make<Option.Option<Fiber.RuntimeFiber<void, Error>>>(
        Option.none(),
      );
      return { logger, mcpManager, finalizeFiberRef };
    }),
    ({ logger, mcpManager: _mcpManager, finalizeFiberRef }) =>
      Effect.gen(function* () {
        const { agent, maxIterations = MAX_AGENT_STEPS } = options;
        const llmService = yield* LLMServiceTag;
        const presentationService = yield* PresentationServiceTag;
        const { actualConversationId, context, tools, messages, runMetrics, provider, model } =
          runContext;

        // Create renderer
        const normalizedStreamingConfig: StreamingConfig = {
          enabled: true, // Always enabled in streaming mode
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

        // Run agent loop
        let currentMessages: ConversationMessages = [messages[0], ...messages.slice(1)];
        let response: AgentResponse = {
          content: "",
          conversationId: actualConversationId,
        };
        let finished = false;
        let iterationsUsed = 0;

        for (let i = 0; i < maxIterations; i++) {
          yield* Effect.sync(() => beginIteration(runMetrics, i + 1));
          try {
            // Log thinking indicator
            if (!options.internal) {
              if (i === 0) {
                yield* presentationService.presentThinking(agent.name, true);
              } else {
                yield* presentationService.presentThinking(agent.name, false);
              }
            }

            // Proactively compact context if approaching token limit
            currentMessages = yield* Summarizer.compactIfNeeded(
              currentMessages,
              agent,
              options.sessionId,
              actualConversationId,
              runRecursive,
            );

            // Create streaming completion with retry and fallback
            const llmOptions = {
              model,
              messages: currentMessages,
              tools,
              toolChoice: "auto" as const,
              reasoning_effort: agent.config.reasoningEffort ?? "disable",
            };

            // Log LLM request details
            yield* logger.debug("Sending LLM request", {
              agentId: agent.id,
              conversationId: actualConversationId,
              iteration: i + 1,
              provider,
              model,
              messageCount: currentMessages.length,
              toolsAvailable: tools.length,
              reasoningEffort: agent.config.reasoningEffort,
              lastUserMessage: currentMessages
                .filter((m) => m.role === "user")
                .slice(-1)[0]
                ?.content?.substring(0, 500),
            });

            const completionRef = yield* Ref.make<ChatCompletionResponse | undefined>(undefined);

            const streamingResult = yield* Effect.retry(
              Effect.gen(function* () {
                try {
                  return yield* llmService.createStreamingChatCompletion(provider, llmOptions);
                } catch (error) {
                  recordLLMRetry(runMetrics, error);
                  // Log LLM error details
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
                  // Log the error that caused fallback
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
                    // Log the error
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

            // Wait for stream completion - the stream is cancelled on completion event
            // so the fiber should complete naturally without needing a timeout
            const streamExit = yield* Fiber.await(streamFiber);

            let completion: ChatCompletionResponse;
            if (Exit.isFailure(streamExit)) {
              yield* streamingResult.cancel;
              const error = Cause.failureOption(streamExit.cause);
              if (Option.isSome(error)) {
                yield* logger.error("Stream processing failed", {
                  error: error.value instanceof Error ? error.value.message : String(error.value),
                });
                return yield* Effect.fail(error.value);
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

            // Log LLM response summary
            yield* logger.debug("LLM response received", {
              agentId: agent.id,
              conversationId: actualConversationId,
              iteration: i + 1,
              contentLength: completion.content.length,
              toolCallsCount: completion.toolCalls?.length ?? 0,
              tokenUsage: completion.usage,
              contentPreview: completion.content.substring(0, 300),
            });

            if (completion.usage) {
              recordLLMUsage(runMetrics, completion.usage);
            }

            if (completion.toolsDisabled) {
              response = { ...response, toolsDisabled: true };
            }

            // Add assistant response to conversation
            const assistantMessage = {
              role: "assistant" as const,
              content: completion.content,
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

            currentMessages.push(assistantMessage);

            const trimUpdate = yield* DEFAULT_CONTEXT_WINDOW_MANAGER.trim(
              currentMessages,
              logger,
              agent.id,
              actualConversationId,
            );
            currentMessages = trimUpdate.messages;

            // Handle tool calls
            if (completion.toolCalls && completion.toolCalls.length > 0) {
              // Log agent decision to use tools
              yield* logger.info("Agent decided to use tools", {
                agentId: agent.id,
                conversationId: actualConversationId,
                iteration: i + 1,
                toolsChosen: completion.toolCalls.map((tc) => tc.function.name),
                reasoning: completion.content,
              });

              // Execute tools - use completion.toolCalls as the source of truth
              const toolResults = yield* ToolExecutor.executeToolCalls(
                completion.toolCalls,
                context,
                displayConfig,
                renderer,
                runMetrics,
                agent.id,
                actualConversationId,
                agent.name,
              );

              // Add tool results to conversation
              // Create mapping for quick lookup
              const resultMap = new Map(toolResults.map((r) => [r.toolCallId, r.result]));

              // Validate that all tool calls have results
              const missingResults: string[] = [];
              for (const toolCall of completion.toolCalls) {
                if (toolCall.type === "function" && !resultMap.has(toolCall.id)) {
                  missingResults.push(toolCall.id);
                }
              }
              if (missingResults.length > 0) {
                yield* logger.error("Missing tool results for some tool calls", {
                  agentId: agent.id,
                  conversationId: actualConversationId,
                  missingToolCallIds: missingResults,
                  expectedCount: completion.toolCalls.length,
                  actualCount: toolResults.length,
                });
                return yield* Effect.fail(
                  new Error(
                    `Missing tool results for ${missingResults.length} tool call(s). This indicates a bug in tool execution.`,
                  ),
                );
              }

              // Add tool result messages
              for (const toolCall of completion.toolCalls) {
                if (toolCall.type === "function") {
                  const result = resultMap.get(toolCall.id);
                  // Result should always be defined due to validation above, but add safety check
                  if (result === undefined) {
                    yield* logger.error("Tool result is undefined despite validation", {
                      agentId: agent.id,
                      conversationId: actualConversationId,
                      toolCallId: toolCall.id,
                      toolName: toolCall.function.name,
                    });
                    // Use error result as fallback
                    currentMessages.push({
                      role: "tool",
                      name: toolCall.function.name,
                      content: JSON.stringify({
                        error: "Tool execution result was undefined",
                      }),
                      tool_call_id: toolCall.id,
                    });
                  } else {
                    currentMessages.push({
                      role: "tool",
                      name: toolCall.function.name,
                      content: JSON.stringify(result),
                      tool_call_id: toolCall.id,
                    });
                  }
                }
              }

              response = {
                ...response,
                toolCalls: completion.toolCalls,
                toolResults: Object.fromEntries(toolResults.map((r) => [r.name, r.result])),
              };
              continue;
            }

            // No tool calls - final response
            yield* logger.info("Agent provided final response", {
              agentId: agent.id,
              conversationId: actualConversationId,
              iteration: i + 1,
              completionLength: completion.content.length,
              totalToolsUsed: runMetrics.toolCalls,
            });

            response = { ...response, content: completion.content };
            yield* presentationService.presentCompletion(agent.name);

            iterationsUsed = i + 1;
            finished = true;
            break;
          } finally {
            yield* Effect.sync(() => completeIteration(runMetrics));
          }
        }

        // Post-loop cleanup
        if (!finished) {
          iterationsUsed = maxIterations;
          yield* presentationService.presentWarning(
            agent.name,
            `reached maximum iterations (${maxIterations}) - type 'resume' to continue`,
          );
        } else if (!response.content?.trim() && !response.toolCalls) {
          yield* presentationService.presentWarning(agent.name, "model returned an empty response");
        }

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

        return { ...response, messages: currentMessages };
      }),
    ({ logger, mcpManager, finalizeFiberRef }) =>
      Effect.gen(function* () {
        const fiberOption = yield* Ref.get(finalizeFiberRef);
        if (Option.isSome(fiberOption)) {
          yield* Fiber.await(fiberOption.value).pipe(
            Effect.asVoid,
            Effect.catchAll(() => Effect.void),
          );
        }

        // Disconnect MCP servers used in this conversation
        if (runContext.connectedMCPServers.length > 0 && Option.isSome(mcpManager)) {
          yield* logger.debug(
            `Disconnecting ${runContext.connectedMCPServers.length} MCP server(s) for conversation ${runContext.actualConversationId}`,
          );
          for (const serverName of runContext.connectedMCPServers) {
            yield* mcpManager.value.disconnectServer(serverName).pipe(
              Effect.catchAll((error) =>
                logger.warn(`Failed to disconnect MCP server ${serverName}`, {
                  error: error instanceof Error ? error.message : String(error),
                }),
              ),
            );
          }
          yield* logger.debug("All MCP servers disconnected for this conversation");
        }

        yield* logger.clearSessionId();
      }),
  );
}
