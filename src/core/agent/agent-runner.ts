import { Cause, Duration, Effect, Exit, Fiber, Option, Ref, Schedule, Stream } from "effect";

import { MAX_AGENT_STEPS } from "../constants/agent";
import type { ProviderName } from "../constants/models";
import { AgentConfigServiceTag, type AgentConfigService } from "../interfaces/agent-config";
import { LLMServiceTag, type LLMService } from "../interfaces/llm";
import { LoggerServiceTag, type LoggerService } from "../interfaces/logger";
import type { PresentationService } from "../interfaces/presentation";
import { PresentationServiceTag } from "../interfaces/presentation";
import {
  ToolRegistryTag,
  type ToolRegistry,
  type ToolRequirements,
} from "../interfaces/tool-registry";
import type { StreamEvent, StreamingConfig } from "../types";
import { type Agent } from "../types";
import { type ChatCompletionResponse } from "../types/chat";
import { LLMAuthenticationError, LLMRateLimitError, LLMRequestError } from "../types/errors";
import { type ChatMessage } from "../types/message";
import type { DisplayConfig } from "../types/output";
import { type ToolCall, type ToolDefinition, type ToolExecutionContext } from "../types/tools";
import { shouldEnableStreaming } from "../utils/stream-detector";
import { agentPromptBuilder } from "./agent-prompt";
import { DEFAULT_CONTEXT_WINDOW_MANAGER } from "./context-window-manager";
import { ToolExecutor } from "./execution/tool-executor";
import {
  beginIteration,
  completeIteration,
  createAgentRunTracker,
  finalizeAgentRun,
  recordFirstTokenLatency,
  recordLLMRetry,
  recordLLMUsage,
} from "./tracking/agent-run-tracker";
import { normalizeToolConfig } from "./utils/tool-config";

const MAX_RETRIES = 3;
const STREAM_CREATION_TIMEOUT = Duration.minutes(2);
const DEFERRED_RESPONSE_TIMEOUT = Duration.seconds(15);

/**
 * Agent runner for executing agent conversations
 */

/**
 * Configuration options for running an agent conversation.
 *
 * This interface defines all the parameters needed to execute a single turn of an agent conversation,
 * including the agent configuration, user input, conversation context, and execution settings.
 *
 */
export interface AgentRunnerOptions {
  /**
   * The agent to execute.
   */
  readonly agent: Agent;
  /**
   * The user's input or query for this conversation turn.
   * This is the primary instruction that the agent will process and respond to.
   */
  readonly userInput: string;
  /**
   * Optional conversation identifier for tracking multi-turn conversations.
   * If not provided, a new conversation ID will be generated automatically.
   * Use the same conversation ID across multiple turns to maintain context.
   */
  readonly conversationId?: string;
  /**
   * Session identifier for logging purposes.
   * This should be set to the sessionId created at the start of a chat session.
   * Used to route logs to session-specific log files.
   */
  readonly sessionId: string;
  /**
   * Maximum number of iterations (agent reasoning loops) allowed for this run.
   * Each iteration may involve tool calls and LLM responses.
   * If not specified, defaults to `MAX_AGENT_STEPS` constant.
   * The agent will stop when it reaches this limit or completes its task.
   */
  readonly maxIterations?: number;
  /**
   * Full conversation history to date, including prior assistant, user, and tool messages.
   * Use this to preserve context across turns (e.g., approval flows, multi-step tasks).
   */
  readonly conversationHistory?: ChatMessage[];
  /**
   * Override streaming behavior (from --stream or --no-stream CLI flags).
   * - `true`: Force streaming on - responses are rendered in real-time as they're generated
   * - `false`: Force streaming off - wait for complete response before rendering
   * - `undefined`: Use auto-detection based on environment and configuration (default)
   */
  readonly stream?: boolean;
}

/**
 * Response returned from executing an agent conversation.
 *
 * Contains the agent's response content, conversation metadata, tool execution results,
 * and the full message history for this turn. Use this to:
 * - Display the agent's response to the user
 * - Pass conversation history to subsequent turns
 * - Inspect tool calls and results for debugging or auditing
 * - Track conversation state and context
 */
export interface AgentResponse {
  /**
   * The agent's text response content.
   * This is the final answer or message from the agent after processing the user input
   * and executing any necessary tools. May be empty if the agent only performed tool calls
   * without providing a text response.
   */
  readonly content: string;
  /**
   * The conversation identifier for this run.
   * This will be the same as the `conversationId` provided in options, or a newly generated
   * ID if one wasn't provided. Use this to track and correlate related conversation turns.
   */
  readonly conversationId: string;
  /**
   * Optional array of tool calls made by the agent during this turn.
   * Present when the agent decided to use tools to accomplish the task.
   * Each tool call includes the tool name, arguments, and call ID.
   *
   * @example
   * ```typescript
   * if (response.toolCalls) {
   *   response.toolCalls.forEach(call => {
   *     console.log(`Agent called: ${call.function.name}`);
   *   });
   * }
   * ```
   */
  readonly toolCalls?: ToolCall[];
  /**
   * Optional map of tool execution results, keyed by tool name.
   * Present when tools were executed during this turn.
   * Contains the results returned by each tool, which may include data, errors, or status information.
   *
   * @example
   * ```typescript
   * if (response.toolResults) {
   *   const emailResults = response.toolResults["gmail_list_emails"];
   *   console.log("Emails retrieved:", emailResults);
   * }
   * ```
   */
  readonly toolResults?: Record<string, unknown>;
  /**
   * The full message list used for this turn, including system, user, assistant, and tool messages.
   * Pass this back on the next turn to retain context across approvals and multi-step tasks.
   *
   * This array contains the complete conversation state, including:
   * - System messages (agent instructions)
   * - User messages (input)
   * - Assistant messages (agent responses)
   * - Tool messages (tool execution results)
   */
  readonly messages?: ChatMessage[] | undefined;
}

/**
 * Default display configuration (applies to both modes)
 */
const DEFAULT_DISPLAY_CONFIG: DisplayConfig = {
  showThinking: true,
  showToolExecution: true,
  mode: "markdown",
};

/**
 * Common initialization data for agent runs
 */
interface AgentRunContext {
  readonly agent: Agent;
  readonly actualConversationId: string;
  readonly context: ToolExecutionContext;
  readonly tools: ToolDefinition[];
  readonly expandedToolNames: readonly string[];
  readonly messages: ChatMessage[];
  readonly runTracker: ReturnType<typeof createAgentRunTracker>;
  readonly provider: ProviderName;
  readonly model: string;
}

/**
 * Initialize common agent run context (tools, messages, tracker)
 */
function initializeAgentRun(
  options: AgentRunnerOptions,
): Effect.Effect<AgentRunContext, Error, ToolRegistry | LoggerService | AgentConfigService> {
  return Effect.gen(function* () {
    const { agent, userInput, conversationId } = options;
    const toolRegistry = yield* ToolRegistryTag;

    const actualConversationId = conversationId || `${Date.now()}`;
    const history: ChatMessage[] = options.conversationHistory || [];
    const agentType = agent.config.agentType;
    const provider: ProviderName = agent.config.llmProvider;
    const model = agent.config.llmModel;

    const runTracker = createAgentRunTracker({
      agent,
      conversationId: actualConversationId,
      provider,
      model,
      reasoningEffort: agent.config.reasoningEffort ?? "disable",
      maxIterations: options.maxIterations ?? MAX_AGENT_STEPS,
    });

    // Get and validate tools
    const allToolNames = yield* toolRegistry.listTools();
    const agentToolNames = normalizeToolConfig(agent.config.tools, {
      agentId: agent.id,
    });

    const invalidTools = agentToolNames.filter((toolName) => !allToolNames.includes(toolName));
    if (invalidTools.length > 0) {
      return yield* Effect.fail(
        new Error(`Agent ${agent.id} references non-existent tools: ${invalidTools.join(", ")}`),
      );
    }

    // Expand tool names to include approval execute tools
    const expandedToolNameSet = new Set(agentToolNames);
    for (const toolName of agentToolNames) {
      const tool = yield* toolRegistry.getTool(toolName);
      if (tool.approvalExecuteToolName) {
        expandedToolNameSet.add(tool.approvalExecuteToolName);
      }
    }

    const expandedToolNames = Array.from(expandedToolNameSet);
    const allTools = yield* toolRegistry.getToolDefinitions();
    const tools = Array.from(
      allTools.filter((tool) => expandedToolNames.includes(tool.function.name)),
    );

    // Build tool descriptions map
    const availableTools: Record<string, string> = {};
    for (const tool of tools) {
      availableTools[tool.function.name] = tool.function.description;
    }

    // Build messages
    const messages = yield* agentPromptBuilder.buildAgentMessages(agentType, {
      agentName: agent.name,
      agentDescription: agent.description || "",
      userInput,
      conversationHistory: history,
      toolNames: expandedToolNames,
      availableTools,
    });

    const toolContext: ToolExecutionContext = {
      agentId: agent.id,
      conversationId: actualConversationId,
    };

    return {
      agent,
      actualConversationId,
      context: toolContext,
      tools,
      expandedToolNames,
      messages,
      runTracker,
      provider,
      model,
    };
  });
}

/**
 * Ensure messages array is never empty
 * throws error if empty
 */
function ensureMessagesNotEmpty(
  messages: ChatMessage[],
  userInput: string,
  logger: LoggerService,
  agentId: string,
  conversationId: string,
  iteration: number,
): Effect.Effect<ChatMessage[], Error, LoggerService | AgentConfigService> {
  if (messages.length === 0) {
    return Effect.gen(function* () {
      yield* logger.error("Messages array is empty - this indicates a bug", {
        agentId,
        conversationId,
        iteration,
        userInput: userInput || "<empty>",
      });

      return yield* Effect.fail(
        new Error(
          `Messages array is empty at iteration ${iteration}. This should never happen - ` +
            `the system message should always be present. This indicates a bug in message building or context trimming. ` +
            `Agent: ${agentId}, Conversation: ${conversationId}`,
        ),
      );
    });
  }
  return Effect.succeed(messages);
}

export class AgentRunner {
  /**
   * Run an agent conversation
   */
  static run(
    options: AgentRunnerOptions,
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
      // Get services
      const configService = yield* AgentConfigServiceTag;
      const appConfig = yield* configService.appConfig;

      // Determine if streaming should be enabled
      const streamDetection = shouldEnableStreaming(
        appConfig,
        options.stream !== undefined ? { stream: options.stream } : {},
      );

      // Get display config with defaults
      const displayConfig: DisplayConfig = {
        showThinking: appConfig.output?.showThinking ?? DEFAULT_DISPLAY_CONFIG.showThinking,
        showToolExecution:
          appConfig.output?.showToolExecution ?? DEFAULT_DISPLAY_CONFIG.showToolExecution,
        mode: appConfig.output?.mode ?? DEFAULT_DISPLAY_CONFIG.mode,
        colorProfile: appConfig.output?.colorProfile,
      };

      // Check if we should show metrics
      const showMetrics = appConfig.output?.showMetrics ?? true;

      // Get streaming config with defaults (streaming-specific)
      const streamingConfig: StreamingConfig = {
        ...(appConfig.output?.streaming?.enabled !== undefined
          ? { enabled: appConfig.output.streaming.enabled }
          : {}),
        ...(appConfig.output?.streaming?.textBufferMs !== undefined
          ? { textBufferMs: appConfig.output.streaming.textBufferMs }
          : {}),
      };

      if (streamDetection.shouldStream) {
        return yield* AgentRunner.runWithStreaming(
          options,
          displayConfig,
          streamingConfig,
          showMetrics,
        );
      } else {
        return yield* AgentRunner.runWithoutStreaming(options, displayConfig, showMetrics);
      }
    });
  }

  /**
   * Streaming implementation that processes LLM responses in real-time.
   */
  private static runWithStreaming(
    options: AgentRunnerOptions,
    displayConfig: DisplayConfig,
    streamingConfig: StreamingConfig,
    showMetrics: boolean,
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
        const runContext = yield* initializeAgentRun(options);

        yield* logger.setSessionId(options.sessionId);

        const finalizeFiberRef = yield* Ref.make<Option.Option<Fiber.RuntimeFiber<void, Error>>>(
          Option.none(),
        );
        return { logger, runContext, finalizeFiberRef };
      }),
      ({ logger, runContext, finalizeFiberRef }) =>
        Effect.gen(function* () {
          const { agent, userInput, maxIterations = MAX_AGENT_STEPS } = options;
          const llmService = yield* LLMServiceTag;
          const presentationService = yield* PresentationServiceTag;
          const { actualConversationId, context, tools, messages, runTracker, provider, model } =
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
          const currentMessages = [...messages];
          let response: AgentResponse = {
            content: "",
            conversationId: actualConversationId,
          };
          let finished = false;
          let iterationsUsed = 0;

          for (let i = 0; i < maxIterations; i++) {
            yield* Effect.sync(() => beginIteration(runTracker, i + 1));
            try {
              // Log thinking indicator
              if (i === 0) {
                const thinkingMsg = yield* presentationService.formatThinking(agent.name, true);
                yield* logger.info(thinkingMsg);
              } else {
                const thinkingMsg = yield* presentationService.formatThinking(agent.name, false);
                yield* logger.info(thinkingMsg);
              }

              // Ensure messages are not empty
              const messagesToSend = yield* ensureMessagesNotEmpty(
                currentMessages,
                userInput,
                logger,
                agent.id,
                actualConversationId,
                i + 1,
              );

              // Create streaming completion with retry and fallback
              const llmOptions = {
                model,
                messages: messagesToSend,
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
                messageCount: messagesToSend.length,
                toolsAvailable: tools.length,
                reasoningEffort: agent.config.reasoningEffort,
                lastUserMessage: messagesToSend
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
                    recordLLMRetry(runTracker, error);
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
                        recordFirstTokenLatency(runTracker, event.metrics.firstTokenLatencyMs);
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
                recordLLMUsage(runTracker, completion.usage);
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
                        ...(tc.thought_signature
                          ? { thought_signature: tc.thought_signature }
                          : {}),
                      })),
                    }
                  : {}),
              };

              currentMessages.push(assistantMessage);

              yield* DEFAULT_CONTEXT_WINDOW_MANAGER.trim(
                currentMessages,
                logger,
                agent.id,
                actualConversationId,
              );

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
                  runTracker,
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
                totalToolsUsed: runTracker.toolCalls,
              });

              response = { ...response, content: completion.content };
              const completionMsg = yield* presentationService.formatCompletion(agent.name);
              yield* logger.info(completionMsg);

              iterationsUsed = i + 1;
              finished = true;
              break;
            } finally {
              yield* Effect.sync(() => completeIteration(runTracker));
            }
          }

          // Post-loop cleanup
          if (!finished) {
            iterationsUsed = maxIterations;
            const warningMessage = yield* presentationService.formatWarning(
              agent.name,
              `reached maximum iterations (${maxIterations}) - type 'resume' to continue`,
            );
            yield* presentationService.writeBlankLine();
            yield* presentationService.writeOutput(warningMessage);
            yield* presentationService.writeBlankLine();
            yield* logger.warn(warningMessage);
          } else if (!response.content?.trim() && !response.toolCalls) {
            const warningMessage = yield* presentationService.formatWarning(
              agent.name,
              "model returned an empty response",
            );
            yield* presentationService.writeBlankLine();
            yield* presentationService.writeOutput(warningMessage);
            yield* presentationService.writeBlankLine();
            yield* logger.warn(warningMessage);
          }

          const finalizeFiber = yield* finalizeAgentRun(runTracker, {
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

  /**
   * Non-streaming implementation that waits for complete LLM responses before rendering.
   */
  private static runWithoutStreaming(
    options: AgentRunnerOptions,
    displayConfig: DisplayConfig,
    showMetrics: boolean,
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
        const runContext = yield* initializeAgentRun(options);
        yield* logger.setSessionId(options.sessionId);
        const finalizeFiberRef = yield* Ref.make<Option.Option<Fiber.RuntimeFiber<void, Error>>>(
          Option.none(),
        );
        return { logger, runContext, finalizeFiberRef };
      }),
      ({ logger, runContext, finalizeFiberRef }) =>
        Effect.gen(function* () {
          const { agent, userInput, maxIterations = MAX_AGENT_STEPS } = options;
          const llmService = yield* LLMServiceTag;
          const presentationService = yield* PresentationServiceTag;
          const { actualConversationId, context, tools, messages, runTracker, provider, model } =
            runContext;

          // Run agent loop
          const currentMessages = [...messages];
          let response: AgentResponse = {
            content: "",
            conversationId: actualConversationId,
          };
          let finished = false;
          let iterationsUsed = 0;

          for (let i = 0; i < maxIterations; i++) {
            yield* Effect.sync(() => beginIteration(runTracker, i + 1));
            try {
              // Log thinking indicator
              if (displayConfig.showThinking) {
                if (i === 0) {
                  const thinkingMsg = yield* presentationService.formatThinking(agent.name, true);
                  yield* logger.info(thinkingMsg);
                } else {
                  const thinkingMsg = yield* presentationService.formatThinking(agent.name, false);
                  yield* logger.info(thinkingMsg);
                }
              }

              // Ensure messages are not empty
              const messagesToSend = yield* ensureMessagesNotEmpty(
                currentMessages,
                userInput,
                logger,
                agent.id,
                actualConversationId,
                i + 1,
              );

              // Create non-streaming completion with retry
              const llmOptions = {
                model,
                messages: messagesToSend,
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
                messageCount: messagesToSend.length,
                toolsAvailable: tools.length,
                reasoningEffort: agent.config.reasoningEffort,
                lastUserMessage: messagesToSend
                  .filter((m) => m.role === "user")
                  .slice(-1)[0]
                  ?.content?.substring(0, 500),
              });

              const completion = yield* Effect.retry(
                Effect.gen(function* () {
                  try {
                    return yield* llmService.createChatCompletion(provider, llmOptions);
                  } catch (error) {
                    recordLLMRetry(runTracker, error);
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
                recordLLMUsage(runTracker, completion.usage);
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
                        ...(tc.thought_signature
                          ? { thought_signature: tc.thought_signature }
                          : {}),
                      })),
                    }
                  : {}),
              };

              currentMessages.push(assistantMessage);

              yield* DEFAULT_CONTEXT_WINDOW_MANAGER.trim(
                currentMessages,
                logger,
                agent.id,
                actualConversationId,
              );

              // Format content - always use markdown since LLMs output markdown
              let formattedContent = completion.content;
              if (formattedContent) {
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
                  runTracker,
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
                totalToolsUsed: runTracker.toolCalls,
              });

              response = { ...response, content: formattedContent };

              // Display final response
              if (formattedContent && formattedContent.trim().length > 0) {
                const formattedResponse = yield* presentationService.formatAgentResponse(
                  agent.name,
                  formattedContent,
                );
                yield* presentationService.writeBlankLine();
                yield* presentationService.writeOutput(formattedResponse);
                yield* presentationService.writeBlankLine();
              }

              const completionMsg = yield* presentationService.formatCompletion(agent.name);
              yield* logger.info(completionMsg);

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
              yield* Effect.sync(() => completeIteration(runTracker));
            }
          }

          // Post-loop cleanup
          if (!finished) {
            iterationsUsed = maxIterations;
            const warningMsg = yield* presentationService.formatWarning(
              agent.name,
              `reached maximum iterations (${maxIterations}) - type 'resume' to continue`,
            );
            yield* logger.warn(warningMsg);
          } else if (!response.content?.trim() && !response.toolCalls) {
            const warningMsg = yield* presentationService.formatWarning(
              agent.name,
              "model returned an empty response",
            );
            yield* logger.warn(warningMsg);
          }

          const finalizeFiber = yield* finalizeAgentRun(runTracker, {
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
}
