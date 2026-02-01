import { Effect, Fiber, Option, Ref, Schedule } from "effect";
import { MAX_AGENT_STEPS } from "@/core/constants/agent";
import { type AgentConfigService } from "@/core/interfaces/agent-config";
import { LLMServiceTag, type LLMService } from "@/core/interfaces/llm";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import { MCPServerManagerTag } from "@/core/interfaces/mcp-server";
import type { PresentationService } from "@/core/interfaces/presentation";
import { PresentationServiceTag } from "@/core/interfaces/presentation";
import type { ToolRegistry, ToolRequirements } from "@/core/interfaces/tool-registry";
import type { ConversationMessages } from "@/core/types";
import { LLMRateLimitError } from "@/core/types/errors";
import type { DisplayConfig } from "@/core/types/output";
import { ToolExecutor } from "./tool-executor";
import { DEFAULT_CONTEXT_WINDOW_MANAGER } from "../context/context-window-manager";
import { Summarizer, type RecursiveRunner } from "../context/summarizer";
import {
  beginIteration,
  completeIteration,
  finalizeAgentRun,
  recordLLMRetry,
  recordLLMUsage,
} from "../metrics/agent-run-metrics";
import type { AgentResponse, AgentRunContext, AgentRunnerOptions } from "../types";

const MAX_RETRIES = 3;

/**
 * Non-streaming implementation that waits for complete LLM responses before rendering.
 */
export function executeWithoutStreaming(
  options: AgentRunnerOptions,
  runContext: AgentRunContext,
  displayConfig: DisplayConfig,
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
            if (!options.internal && displayConfig.showThinking) {
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

            // Create non-streaming completion with retry
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

            const completion = yield* Effect.retry(
              Effect.gen(function* () {
                try {
                  return yield* llmService.createChatCompletion(provider, llmOptions);
                } catch (error) {
                  recordLLMRetry(runMetrics, error);
                  throw error;
                }
              }),
              Schedule.exponential("1 second").pipe(
                Schedule.intersect(Schedule.recurs(MAX_RETRIES)),
                Schedule.whileInput((error) => error instanceof LLMRateLimitError),
              ),
            );

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

            // Format content only when markdown mode is enabled
            let formattedContent = completion.content;
            if (formattedContent && displayConfig.mode === "markdown") {
              formattedContent = yield* presentationService.renderMarkdown(formattedContent);
            }

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

              const toolResults = yield* ToolExecutor.executeToolCalls(
                completion.toolCalls,
                context,
                displayConfig,
                null, // No renderer for non-streaming
                runMetrics,
                agent.id,
                actualConversationId,
                agent.name,
              );

              // Add tool results to conversation
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

            response = { ...response, content: formattedContent };

            // Display final response
            if (formattedContent && formattedContent.trim().length > 0) {
              yield* presentationService.writeBlankLine();
              yield* presentationService.presentAgentResponse(agent.name, formattedContent);
              yield* presentationService.writeBlankLine();
            }

            yield* presentationService.presentCompletion(agent.name);

            // Show metrics if enabled
            if (showMetrics && completion.usage) {
              const parts: string[] = [];
              if (completion.usage.totalTokens)
                parts.push(`Total: ${completion.usage.totalTokens} tokens`);
              if (completion.usage.promptTokens)
                parts.push(`Prompt: ${completion.usage.promptTokens}`);
              if (completion.usage.completionTokens)
                parts.push(`Completion: ${completion.usage.completionTokens}`);
              if (parts.length > 0) {
                yield* logger.info(`[${parts.join(" | ")}]`);
              }
            }

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
            `iteration limit reached (${maxIterations}) - type 'continue' to resume`,
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

        return {
          ...response,
          messages: currentMessages,
          usage: {
            promptTokens: runMetrics.totalPromptTokens,
            completionTokens: runMetrics.totalCompletionTokens,
          },
        };
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
