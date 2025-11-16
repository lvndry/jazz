import { Cause, Duration, Effect, Exit, Fiber, Option, Schedule, Stream } from "effect";

import { MAX_AGENT_STEPS } from "../../constants/agent";
import { AgentConfigService, type ConfigService } from "../../services/config";
import { shouldEnableStreaming } from "../../services/llm/stream-detector";
import type { StreamEvent } from "../../services/llm/streaming-types";
import {
  LLMRateLimitError,
  LLMServiceTag,
  type ChatCompletionResponse,
  type ChatMessage,
  type LLMService,
  type ToolCall,
} from "../../services/llm/types";
import { LoggerServiceTag, type LoggerService } from "../../services/logger";
import type { StreamingConfig } from "../types";
import { type Agent } from "../types";
import { MarkdownRenderer } from "../utils/markdown-renderer";
import { StreamRenderer, type DisplayConfig } from "../utils/stream-renderer";
import { agentPromptBuilder } from "./agent-prompt";
import {
  ToolRegistryTag,
  type ToolExecutionContext,
  type ToolExecutionResult,
  type ToolRegistry,
} from "./tools/tool-registry";
import {
  beginIteration,
  completeIteration,
  createAgentRunTracker,
  finalizeAgentRun,
  recordLLMRetry,
  recordLLMUsage,
  recordToolError,
  recordToolInvocation,
} from "./tracking/agent-run-tracker";
import { normalizeToolConfig } from "./utils/tool-config";

/**
 * Agent runner for executing agent conversations
 */

export interface AgentRunnerOptions {
  readonly agent: Agent;
  readonly userInput: string;
  readonly conversationId?: string;
  readonly userId?: string;
  readonly maxIterations?: number;
  /**
   * Full conversation history to date, including prior assistant, user, and tool messages.
   * Use this to preserve context across turns (e.g., approval flows).
   */
  readonly conversationHistory?: ChatMessage[];
  /**
   * Force streaming on (from --stream CLI flag)
   */
  readonly forceStream?: boolean;
  /**
   * Force streaming off (from --no-stream CLI flag)
   */
  readonly forceNoStream?: boolean;
}

export interface AgentResponse {
  readonly content: string;
  readonly conversationId: string;
  readonly toolCalls?: ToolCall[];
  readonly toolResults?: Record<string, unknown>;
  /**
   * The full message list used for this turn, including system, user, assistant, and tool messages.
   * Pass this back on the next turn to retain context across approvals and multi-step tasks.
   */
  readonly messages?: ChatMessage[] | undefined;
  /**
   * Indicates if streaming was used for this response.
   * When true, the response content was already displayed during streaming.
   */
  readonly wasStreamed?: boolean;
}

/**
 * Default display configuration (applies to both modes)
 */
const DEFAULT_DISPLAY_CONFIG: DisplayConfig = {
  showThinking: true,
  showToolExecution: true,
  format: "markdown",
};


export class AgentRunner {
  /**
   * Run an agent conversation
   */
  static run(
    options: AgentRunnerOptions,
  ): Effect.Effect<
    AgentResponse,
    LLMRateLimitError | Error,
    LLMService | ToolRegistry | LoggerService | ConfigService
  > {
    return Effect.gen(function* () {
      // Get services
      const configService = yield* AgentConfigService;
      const appConfig = yield* configService.appConfig;

      // Determine if streaming should be enabled
      const streamDetection = shouldEnableStreaming(appConfig, {
        ...(options.forceStream !== undefined ? { forceStream: options.forceStream } : {}),
        ...(options.forceNoStream !== undefined ? { forceNoStream: options.forceNoStream } : {}),
      });

      // Get display config with defaults (applies to both modes)
      const displayConfig: DisplayConfig = {
        showThinking: appConfig.output?.showThinking ?? DEFAULT_DISPLAY_CONFIG.showThinking,
        showToolExecution:
          appConfig.output?.showToolExecution ?? DEFAULT_DISPLAY_CONFIG.showToolExecution,
        format: appConfig.output?.format ?? DEFAULT_DISPLAY_CONFIG.format,
      };

      // Check if we should show metrics (from logging config)
      const showMetrics = appConfig.logging?.showMetrics ?? false;

      // Get streaming config with defaults (streaming-specific)
      const streamingConfig: StreamingConfig = {
        ...(appConfig.output?.streaming?.enabled !== undefined
          ? { enabled: appConfig.output.streaming.enabled }
          : {}),
        ...(appConfig.output?.streaming?.progressiveMarkdown !== undefined
          ? { progressiveMarkdown: appConfig.output.streaming.progressiveMarkdown }
          : {}),
        ...(appConfig.output?.streaming?.textBufferMs !== undefined
          ? { textBufferMs: appConfig.output.streaming.textBufferMs }
          : {}),
      };

      if (streamDetection.shouldStream) {
        // Use streaming path
        return yield* AgentRunner.runWithStreaming(
          options,
          displayConfig,
          streamingConfig,
          showMetrics,
        );
      } else {
        // Use non-streaming path (but still apply display config)
        return yield* AgentRunner.runWithoutStreaming(options, displayConfig, showMetrics);
      }
    });
  }

  /**
   * Streaming implementation
   */
  private static runWithStreaming(
    options: AgentRunnerOptions,
    displayConfig: DisplayConfig,
    streamingConfig: StreamingConfig,
    showMetrics: boolean,
  ): Effect.Effect<
    AgentResponse,
    LLMRateLimitError | Error,
    LLMService | ToolRegistry | LoggerService | ConfigService
  > {
    return Effect.gen(function* () {
      const { agent, userInput, conversationId, userId, maxIterations = MAX_AGENT_STEPS } =
        options;

      // Get services
      const llmService = yield* LLMServiceTag;
      const toolRegistry = yield* ToolRegistryTag;
      const configService = yield* AgentConfigService;
      const logger = yield* LoggerServiceTag;
      const appConfig = yield* configService.appConfig;

      // Generate a conversation ID if not provided
      const actualConversationId = conversationId || `conv-${Date.now()}`;

      // Use provided history if available to preserve context across turns
      const history: ChatMessage[] = options.conversationHistory || [];

      const agentType = agent.config.agentType;
      const provider = agent.config.llmProvider;
      const model = agent.config.llmModel;

      const runTracker = createAgentRunTracker({
        agent,
        conversationId: actualConversationId,
        ...(userId ? { userId } : {}),
        provider,
        model,
        reasoningEffort: agent.config.reasoningEffort ?? "disable",
        maxIterations,
      });

      // Get available tools for this specific agent
      const allToolNames = yield* toolRegistry.listTools();
      const agentToolNames = normalizeToolConfig(agent.config.tools, {
        agentId: agent.id,
      });

      // Validate that all agent tools exist in the registry
      const invalidTools = agentToolNames.filter((toolName) => !allToolNames.includes(toolName));
      if (invalidTools.length > 0) {
        return yield* Effect.fail(
          new Error(`Agent ${agent.id} references non-existent tools: ${invalidTools.join(", ")}`),
        );
      }

      // Automatically include approval follow-up tools (e.g., execute-* variants)
      const expandedToolNameSet = new Set(agentToolNames);
      for (const toolName of agentToolNames) {
        const tool = yield* toolRegistry.getTool(toolName);
        if (tool.approvalExecuteToolName) {
          expandedToolNameSet.add(tool.approvalExecuteToolName);
        }
      }

      const expandedToolNames = Array.from(expandedToolNameSet);

      // Get tool definitions for only the agent's specified tools
      const allTools = yield* toolRegistry.getToolDefinitions();
      const tools = allTools.filter((tool) => expandedToolNames.includes(tool.function.name));

      // Build a map of available tool descriptions for prompt clarity
      const availableTools: Record<string, string> = {};
      for (const tool of tools) {
        availableTools[tool.function.name] = tool.function.description;
      }

      // Build messages for the agent with only its specified tools and descriptions
      const messages = yield* agentPromptBuilder.buildAgentMessages(agentType, {
        agentName: agent.name,
        agentDescription: agent.description,
        userInput,
        conversationHistory: history,
        toolNames: expandedToolNames,
        availableTools,
      });

      // Create execution context
      const context: ToolExecutionContext = {
        agentId: agent.id,
        conversationId: actualConversationId,
        ...(userId ? { userId } : {}),
      };

      // Create stream renderer with defaults applied
      const rendererConfig: StreamingConfig = {
        ...(streamingConfig.progressiveMarkdown !== undefined && {
          progressiveMarkdown: streamingConfig.progressiveMarkdown,
        }),
        ...(streamingConfig.textBufferMs !== undefined && {
          textBufferMs: streamingConfig.textBufferMs,
        }),
      };
      const renderer = new StreamRenderer(displayConfig, rendererConfig, showMetrics, agent.name);

      // Run the agent loop
      const currentMessages = [...messages];
      let response: AgentResponse = {
        content: "",
        conversationId: actualConversationId,
      };
      let finished = false;
      let iterationsUsed = 0;

      // Memory safeguard: prevent unbounded message growth
      const MAX_MESSAGES = 100;

      // Determine the LLM provider and model to use
      for (let i = 0; i < maxIterations; i++) {
        yield* Effect.sync(() => beginIteration(runTracker, i + 1));
        try {
          // Log user-friendly progress for info level
          if (i === 0) {
            const message = MarkdownRenderer.formatThinking(agent.name, true);
            yield* logger.info(message, {
              agentId: agent.id,
              conversationId: actualConversationId,
              iteration: i + 1,
            });
          } else {
            const message = MarkdownRenderer.formatThinking(agent.name, false);
            yield* logger.info(message, {
              agentId: agent.id,
              conversationId: actualConversationId,
              iteration: i + 1,
            });
          }

          // Log LLM request in debug mode
          if (appConfig.logging.level === "debug") {
            yield* logger.debug("LLM request", {
              agentId: agent.id,
              conversationId: actualConversationId,
              iteration: i + 1,
              provider,
              model,
              messageCount: currentMessages.length,
              messages: currentMessages,
              tools: tools.map((t) => ({
                name: t.function.name,
                description: t.function.description,
              })),
            });
          }

          // Call the LLM with streaming and retry logic for rate limit errors
          let messagesToSend = currentMessages;
          // Secondary safety: ensure messagesToSend is never empty
          if (messagesToSend.length === 0) {
            // Fallback to a single user message if everything else failed
            messagesToSend = [
              {
                role: "user",
                content: userInput && userInput.trim().length > 0 ? userInput : "Continue",
              },
            ];
            yield* logger.warn("messagesToSend was empty; using fallback single user message", {
              agentId: agent.id,
              conversationId: actualConversationId,
              iteration: i + 1,
            });
          }
          const maxRetries = 3;

          // Track tool calls during streaming for execution
          const pendingToolCalls: ToolCall[] = [];

          // Default timeout: 5 minutes (300 seconds) or use agent timeout if configured
          const streamTimeoutMs = agent.config.timeout ?? 300000; // 5 minutes default
          const streamTimeout = Duration.millis(streamTimeoutMs);

          // Create streaming result with graceful degradation
          const streamingResult = yield* Effect.retry(
            Effect.gen(function* () {
              const llmOptions = {
                model,
                messages: messagesToSend,
                tools,
                toolChoice: "auto" as const,
                reasoning_effort: agent.config.reasoningEffort ?? "disable",
              };

              try {
                const result = yield* llmService.createStreamingChatCompletion(provider, llmOptions);
                return result;
              } catch (error) {
                recordLLMRetry(runTracker, error);
                throw error;
              }
            }),
            Schedule.exponential("1 second").pipe(
              Schedule.intersect(Schedule.recurs(maxRetries)),
              Schedule.whileInput((error) => error instanceof LLMRateLimitError),
            ),
          ).pipe(
            // Add timeout to stream creation
            Effect.timeout(streamTimeout),
            // Graceful degradation: fallback to non-streaming on error
            Effect.catchAll((error) =>
              Effect.gen(function* () {
                yield* logger.warn("Streaming failed, falling back to non-streaming mode", {
                  agentId: agent.id,
                  conversationId: actualConversationId,
                  iteration: i + 1,
                  error: error instanceof Error ? error.message : String(error),
                });

                // Fallback to non-streaming
                const llmOptions = {
                  model,
                  messages: messagesToSend,
                  tools,
                  toolChoice: "auto" as const,
                  reasoning_effort: agent.config.reasoningEffort ?? "disable",
                };

                const fallbackResult = yield* llmService.createChatCompletion(provider, llmOptions);
                return {
                  stream: Stream.empty,
                  response: Effect.succeed(fallbackResult),
                  cancel: Effect.void,
                };
              }),
            ),
          );

          // Process stream events with timeout and error handling
          const streamWithTimeout = streamingResult.stream.pipe(
            Stream.timeout(streamTimeout),
            Stream.catchAll((error) => {
              // Convert timeout/interruption to error event
              const cause = Cause.isCause(error) ? error : Cause.fail(error);
              if (Cause.isInterruptedOnly(cause)) {
                return Stream.make({
                  type: "error",
                  error: new Error("Stream timeout exceeded") as LLMRateLimitError,
                  recoverable: false,
                } as StreamEvent);
              }
              return Stream.fail(error);
            }),
          );

          // Process stream events and render them with interruption handling
          const streamFiber = yield* Effect.fork(
            Stream.runForEach(streamWithTimeout, (event: StreamEvent) =>
              Effect.gen(function* () {
                // Render the event
                yield* renderer.handleEvent(event);

                // Track tool calls as they come in
                if (event.type === "tool_call") {
                  pendingToolCalls.push(event.toolCall);
                }

                // Handle errors in stream
                if (event.type === "error") {
                  if (!event.recoverable) {
                    // Non-recoverable error - cancel stream
                    yield* streamingResult.cancel;
                  }
                }
              }),
            ),
          );

          // Wait for stream to complete or timeout
          const streamExit = yield* Fiber.await(streamFiber);

          // Get completion - either from stream or fallback
          let completion: ChatCompletionResponse;

          // If stream was interrupted or failed, cancel and fallback
          if (Exit.isFailure(streamExit)) {
            yield* streamingResult.cancel;
            const error = Cause.failureOption(streamExit.cause);
            if (Option.isSome(error)) {
              yield* logger.warn("Stream processing failed, using fallback", {
                agentId: agent.id,
                conversationId: actualConversationId,
                iteration: i + 1,
                error: error.value instanceof Error ? error.value.message : String(error.value),
              });

              // Fallback to non-streaming
              const llmOptions = {
                model,
                messages: messagesToSend,
                tools,
                toolChoice: "auto" as const,
                reasoning_effort: agent.config.reasoningEffort ?? "disable",
              };

              completion = yield* llmService.createChatCompletion(provider, llmOptions);
            } else {
              // Stream was interrupted - cancel and continue to next iteration
              yield* streamingResult.cancel;
              continue;
            }
          } else {
            // Stream completed successfully - get final response
            completion = yield* streamingResult.response.pipe(
              Effect.timeout(streamTimeout),
              Effect.catchAll(() => {
                // If response timeout, cancel and fallback
                return Effect.gen(function* () {
                  yield* streamingResult.cancel;
                  yield* logger.warn("Response timeout, using fallback", {
                    agentId: agent.id,
                    conversationId: actualConversationId,
                    iteration: i + 1,
                  });

                  const llmOptions = {
                    model,
                    messages: messagesToSend,
                    tools,
                    toolChoice: "auto" as const,
                    reasoning_effort: agent.config.reasoningEffort ?? "disable",
                  };

                  return yield* llmService.createChatCompletion(provider, llmOptions);
                });
              }),
            );
          }

          if (completion.usage) {
            recordLLMUsage(runTracker, completion.usage);
          }

          // Add the assistant's response to the conversation (including tool calls, if any)
          currentMessages.push({
            role: "assistant",
            content: completion.content,
            ...(completion.toolCalls
              ? {
                  tool_calls: completion.toolCalls.map((tc) => ({
                    id: tc.id,
                    type: tc.type,
                    function: { name: tc.function.name, arguments: tc.function.arguments },
                  })),
                }
              : {}),
          });

          // Memory safeguard: trim messages if they exceed the limit
          if (currentMessages.length > MAX_MESSAGES) {
            // Keep the system message and the most recent messages
            const systemMessage = currentMessages[0];
            if (systemMessage) {
              const recentMessages = currentMessages.slice(-(MAX_MESSAGES - 1));
              currentMessages.length = 0;
              currentMessages.push(systemMessage, ...recentMessages);
            }

            yield* logger.warn("Message history trimmed to prevent memory issues", {
              agentId: agent.id,
              conversationId: actualConversationId,
              maxMessages: MAX_MESSAGES,
              trimmedCount: currentMessages.length,
            });
          }

          // Log assistant response if log level is debug
          if (appConfig.logging.level === "debug") {
            yield* logger.debug("LLM response received", {
              agentId: agent.id,
              conversationId: actualConversationId,
              iteration: i + 1,
              model: completion.model,
              content: completion.content,
              toolCalls: completion.toolCalls?.map((tc) => ({
                id: tc.id,
                name: tc.function.name,
                arguments: tc.function.arguments,
              })),
              usage: completion.usage,
            });
          }

          // Check if the model wants to call a tool
          if (completion.toolCalls && completion.toolCalls.length > 0) {
            const toolResults: Record<string, unknown> = {};

            // Log user-friendly tool execution info
            const toolNames = completion.toolCalls.map((tc) => tc.function.name);
            const message = MarkdownRenderer.formatToolExecution(agent.name, toolNames);
            yield* logger.info(message, {
              agentId: agent.id,
              conversationId: actualConversationId,
              toolCount: completion.toolCalls.length,
              tools: toolNames,
            });

            // Execute each tool call
            for (const toolCall of completion.toolCalls) {
              if (toolCall.type === "function") {
                const { name, arguments: argsString } = toolCall.function;
                recordToolInvocation(runTracker, name);

                // Emit tool execution start event
                if (displayConfig.showToolExecution) {
                  yield* renderer.handleEvent({
                    type: "tool_execution_start",
                    toolName: name,
                    toolCallId: toolCall.id,
                  });
                }

                const toolStartTime = Date.now();

                try {
                  // Parse the arguments safely with proper error handling
                  let parsed: unknown;
                  try {
                    parsed = JSON.parse(argsString);
                  } catch (parseError) {
                    throw new Error(
                      `Invalid JSON in tool arguments: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
                    );
                  }

                  const args: Record<string, unknown> =
                    parsed && typeof parsed === "object" && !Array.isArray(parsed)
                      ? (parsed as Record<string, unknown>)
                      : {};

                  // Log tool call arguments in debug mode
                  yield* logger.debug("Tool call arguments", {
                    agentId: agent.id,
                    conversationId: actualConversationId,
                    toolName: name,
                    toolCallId: toolCall.id,
                    arguments: args,
                    rawArguments: argsString,
                  });

                  // Execute the tool
                  const result = yield* executeTool(name, args, context);

                  const toolDuration = Date.now() - toolStartTime;
                  const resultString = JSON.stringify(result.result);

                  // Emit tool execution complete event
                  if (displayConfig.showToolExecution) {
                    yield* renderer.handleEvent({
                      type: "tool_execution_complete",
                      toolCallId: toolCall.id,
                      result: resultString,
                      durationMs: toolDuration,
                    });
                  }

                  // Log tool execution result in debug mode
                  yield* logger.debug("Tool execution result", {
                    agentId: agent.id,
                    conversationId: actualConversationId,
                    toolName: name,
                    toolCallId: toolCall.id,
                    arguments: args,
                    result: result.result,
                  });

                  // Add the tool result to the conversation
                  currentMessages.push({
                    role: "tool",
                    name,
                    content: resultString,
                    tool_call_id: toolCall.id,
                  });

                  // Store the tool result
                  toolResults[name] = result.result;
                } catch (error) {
                  // If the tool does not exist, rethrow to fail fast (never mock missing tools)
                  if (error instanceof Error && error.message.startsWith("Tool not found")) {
                    throw error;
                  }

                  const toolDuration = Date.now() - toolStartTime;
                  const errorMessage = error instanceof Error ? error.message : String(error);

                  // Emit tool execution complete event with error
                  if (displayConfig.showToolExecution) {
                    yield* renderer.handleEvent({
                      type: "tool_execution_complete",
                      toolCallId: toolCall.id,
                      result: `Error: ${errorMessage}`,
                      durationMs: toolDuration,
                    });
                  }

                  // Log the tool execution error for debugging
                  recordToolError(runTracker, name, error);
                  yield* logger.error("Tool execution failed", {
                    agentId: agent.id,
                    conversationId: actualConversationId,
                    toolName: name,
                    toolCallId: toolCall.id,
                    error: errorMessage,
                  });

                  // Include the tool execution error in the conversation
                  currentMessages.push({
                    role: "tool",
                    name,
                    content: `Error: ${errorMessage}`,
                    tool_call_id: toolCall.id,
                  });

                  // Store the error
                  toolResults[name] = {
                    error: errorMessage,
                  };
                }
              }
            }

            // Update the response with tool results
            response = { ...response, toolCalls: completion.toolCalls, toolResults };

            // Continue the conversation with the tool results
            continue;
          }

          // No tool calls, we have the final response
          response = { ...response, content: completion.content };

          // Log completion
          const completionMessage = MarkdownRenderer.formatCompletion(agent.name);
          yield* logger.info(completionMessage, {
            agentId: agent.id,
            conversationId: actualConversationId,
            totalIterations: i + 1,
            hasContent: !!completion.content,
          });

          // Mark loop as finished and break
          iterationsUsed = i + 1;
          finished = true;
          break;
        } finally {
          yield* Effect.sync(() => completeIteration(runTracker));
        }
      }

      // Post-loop diagnostics
      if (!finished) {
        iterationsUsed = maxIterations;
        const warningMessage = MarkdownRenderer.formatWarning(
          agent.name,
          `reached maximum iterations (${maxIterations})`,
        );
        yield* logger.warn(warningMessage, {
          agentId: agent.id,
          conversationId: actualConversationId,
          maxIterations,
        });
      } else if (
        (!response.content || response.content.trim().length === 0) &&
        !response.toolCalls
      ) {
        const emptyMessage = MarkdownRenderer.formatWarning(
          agent.name,
          "model returned an empty response",
        );
        yield* logger.warn(emptyMessage, {
          agentId: agent.id,
          conversationId: actualConversationId,
          totalIterations: iterationsUsed,
        });
      }

      yield* finalizeAgentRun(runTracker, {
        iterationsUsed,
        finished,
      }).pipe(
        Effect.catchAll((error) =>
          logger.warn("Failed to write agent token usage log", {
            agentId: agent.id,
            conversationId: actualConversationId,
            error: error.message,
          }),
        ),
      );

      // Optionally persist conversation history via a storage layer in the future

      // Return the full message history from this turn so callers can persist it
      // Mark as streamed since we used streaming mode
      return { ...response, messages: currentMessages, wasStreamed: true };
    });
  }

  /**
   * Non-streaming implementation (applies display config)
   */
  private static runWithoutStreaming(
    options: AgentRunnerOptions,
    displayConfig: DisplayConfig,
    showMetrics: boolean,
  ): Effect.Effect<
    AgentResponse,
    LLMRateLimitError | Error,
    LLMService | ToolRegistry | LoggerService | ConfigService
  > {
    return Effect.gen(function* () {
      const { agent, userInput, conversationId, userId, maxIterations = MAX_AGENT_STEPS } =
        options;

      // Get services
      const llmService = yield* LLMServiceTag;
      const toolRegistry = yield* ToolRegistryTag;
      const configService = yield* AgentConfigService;
      const logger = yield* LoggerServiceTag;
      const appConfig = yield* configService.appConfig;

      // Generate a conversation ID if not provided
      const actualConversationId = conversationId || `conv-${Date.now()}`;

      // Use provided history if available to preserve context across turns
      const history: ChatMessage[] = options.conversationHistory || [];

      const agentType = agent.config.agentType;
      const provider = agent.config.llmProvider;
      const model = agent.config.llmModel;

      const runTracker = createAgentRunTracker({
        agent,
        conversationId: actualConversationId,
        ...(userId ? { userId } : {}),
        provider,
        model,
        reasoningEffort: agent.config.reasoningEffort ?? "disable",
        maxIterations,
      });

      // Get available tools for this specific agent
      const allToolNames = yield* toolRegistry.listTools();
      const agentToolNames = normalizeToolConfig(agent.config.tools, {
        agentId: agent.id,
      });

      // Validate that all agent tools exist in the registry
      const invalidTools = agentToolNames.filter((toolName) => !allToolNames.includes(toolName));
      if (invalidTools.length > 0) {
        return yield* Effect.fail(
          new Error(`Agent ${agent.id} references non-existent tools: ${invalidTools.join(", ")}`),
        );
      }

      // Automatically include approval follow-up tools (e.g., execute-* variants)
      const expandedToolNameSet = new Set(agentToolNames);
      for (const toolName of agentToolNames) {
        const tool = yield* toolRegistry.getTool(toolName);
        if (tool.approvalExecuteToolName) {
          expandedToolNameSet.add(tool.approvalExecuteToolName);
        }
      }

      const expandedToolNames = Array.from(expandedToolNameSet);

      // Get tool definitions for only the agent's specified tools
      const allTools = yield* toolRegistry.getToolDefinitions();
      const tools = allTools.filter((tool) => expandedToolNames.includes(tool.function.name));

      // Build a map of available tool descriptions for prompt clarity
      const availableTools: Record<string, string> = {};
      for (const tool of tools) {
        availableTools[tool.function.name] = tool.function.description;
      }

      // Build messages for the agent with only its specified tools and descriptions
      const messages = yield* agentPromptBuilder.buildAgentMessages(agentType, {
        agentName: agent.name,
        agentDescription: agent.description,
        userInput,
        conversationHistory: history,
        toolNames: expandedToolNames,
        availableTools,
      });

      // Create execution context
      const context: ToolExecutionContext = {
        agentId: agent.id,
        conversationId: actualConversationId,
        ...(userId ? { userId } : {}),
      };

      // Run the agent loop
      const currentMessages = [...messages];
      let response: AgentResponse = {
        content: "",
        conversationId: actualConversationId,
      };
      let finished = false;
      let iterationsUsed = 0;

      // Memory safeguard: prevent unbounded message growth
      const MAX_MESSAGES = 100;

      // Determine the LLM provider and model to use
      for (let i = 0; i < maxIterations; i++) {
        yield* Effect.sync(() => beginIteration(runTracker, i + 1));
        try {
          // Log user-friendly progress for info level (respect display config)
          if (displayConfig.showThinking) {
            if (i === 0) {
              const message = MarkdownRenderer.formatThinking(agent.name, true);
              yield* logger.info(message, {
                agentId: agent.id,
                conversationId: actualConversationId,
                iteration: i + 1,
              });
            } else {
              const message = MarkdownRenderer.formatThinking(agent.name, false);
              yield* logger.info(message, {
                agentId: agent.id,
                conversationId: actualConversationId,
                iteration: i + 1,
              });
            }
          }

          // Log LLM request in debug mode
          if (appConfig.logging.level === "debug") {
            yield* logger.debug("LLM request", {
              agentId: agent.id,
              conversationId: actualConversationId,
              iteration: i + 1,
              provider,
              model,
              messageCount: currentMessages.length,
              messages: currentMessages,
              tools: tools.map((t) => ({
                name: t.function.name,
                description: t.function.description,
              })),
            });
          }

          // Call the LLM with retry logic for rate limit errors
          let messagesToSend = currentMessages;
          // Secondary safety: ensure messagesToSend is never empty
          if (messagesToSend.length === 0) {
            // Fallback to a single user message if everything else failed
            messagesToSend = [
              {
                role: "user",
                content: userInput && userInput.trim().length > 0 ? userInput : "Continue",
              },
            ];
            yield* logger.warn("messagesToSend was empty; using fallback single user message", {
              agentId: agent.id,
              conversationId: actualConversationId,
              iteration: i + 1,
            });
          }
          const maxRetries = 3;

          const completion = yield* Effect.retry(
            Effect.gen(function* () {
              const llmOptions = {
                model,
                messages: messagesToSend,
                tools,
                toolChoice: "auto" as const,
                reasoning_effort: agent.config.reasoningEffort ?? "disable",
              };

              try {
                const result = yield* llmService.createChatCompletion(provider, llmOptions);
                return result;
              } catch (error) {
                recordLLMRetry(runTracker, error);
                throw error;
              }
            }),
            Schedule.exponential("1 second").pipe(
              Schedule.intersect(Schedule.recurs(maxRetries)),
              Schedule.whileInput((error) => error instanceof LLMRateLimitError),
            ),
          );

          if (completion.usage) {
            recordLLMUsage(runTracker, completion.usage);
          }

          // Add the assistant's response to the conversation (including tool calls, if any)
          currentMessages.push({
            role: "assistant",
            content: completion.content,
            ...(completion.toolCalls
              ? {
                  tool_calls: completion.toolCalls.map((tc) => ({
                    id: tc.id,
                    type: tc.type,
                    function: { name: tc.function.name, arguments: tc.function.arguments },
                  })),
                }
              : {}),
          });

          // Memory safeguard: trim messages if they exceed the limit
          if (currentMessages.length > MAX_MESSAGES) {
            // Keep the system message and the most recent messages
            const systemMessage = currentMessages[0];
            if (systemMessage) {
              const recentMessages = currentMessages.slice(-(MAX_MESSAGES - 1));
              currentMessages.length = 0;
              currentMessages.push(systemMessage, ...recentMessages);
            }

            yield* logger.warn("Message history trimmed to prevent memory issues", {
              agentId: agent.id,
              conversationId: actualConversationId,
              maxMessages: MAX_MESSAGES,
              trimmedCount: currentMessages.length,
            });
          }

          // Log assistant response if log level is debug
          if (appConfig.logging.level === "debug") {
            yield* logger.debug("LLM response received", {
              agentId: agent.id,
              conversationId: actualConversationId,
              iteration: i + 1,
              model: completion.model,
              content: completion.content,
              toolCalls: completion.toolCalls?.map((tc) => ({
                id: tc.id,
                name: tc.function.name,
                arguments: tc.function.arguments,
              })),
              usage: completion.usage,
            });
          }

          // Format output based on display config
          let formattedContent = completion.content;
          if (displayConfig.format === "markdown" && formattedContent) {
            formattedContent = MarkdownRenderer.render(formattedContent);
          }

          // Check if the model wants to call a tool
          if (completion.toolCalls && completion.toolCalls.length > 0) {
            const toolResults: Record<string, unknown> = {};

            // Log user-friendly tool execution info (respect display config)
            if (displayConfig.showToolExecution) {
              const toolNames = completion.toolCalls.map((tc) => tc.function.name);
              const message = MarkdownRenderer.formatToolExecution(agent.name, toolNames);
              yield* logger.info(message, {
                agentId: agent.id,
                conversationId: actualConversationId,
                toolCount: completion.toolCalls.length,
                tools: toolNames,
              });
            }

            // Execute each tool call
            for (const toolCall of completion.toolCalls) {
              if (toolCall.type === "function") {
                const { name, arguments: argsString } = toolCall.function;
                recordToolInvocation(runTracker, name);

                try {
                  // Parse the arguments safely with proper error handling
                  let parsed: unknown;
                  try {
                    parsed = JSON.parse(argsString);
                  } catch (parseError) {
                    throw new Error(
                      `Invalid JSON in tool arguments: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
                    );
                  }

                  const args: Record<string, unknown> =
                    parsed && typeof parsed === "object" && !Array.isArray(parsed)
                      ? (parsed as Record<string, unknown>)
                      : {};

                  // Log tool call arguments in debug mode
                  yield* logger.debug("Tool call arguments", {
                    agentId: agent.id,
                    conversationId: actualConversationId,
                    toolName: name,
                    toolCallId: toolCall.id,
                    arguments: args,
                    rawArguments: argsString,
                  });

                  // Execute the tool
                  const result = yield* executeTool(name, args, context);

                  // Log tool execution result in debug mode
                  yield* logger.debug("Tool execution result", {
                    agentId: agent.id,
                    conversationId: actualConversationId,
                    toolName: name,
                    toolCallId: toolCall.id,
                    arguments: args,
                    result: result.result,
                  });

                  // Add the tool result to the conversation
                  currentMessages.push({
                    role: "tool",
                    name,
                    content: JSON.stringify(result.result),
                    tool_call_id: toolCall.id,
                  });

                  // Store the tool result
                  toolResults[name] = result.result;
                } catch (error) {
                  // If the tool does not exist, rethrow to fail fast (never mock missing tools)
                  if (error instanceof Error && error.message.startsWith("Tool not found")) {
                    throw error;
                  }

                  // Log the tool execution error for debugging
                  const errorMessage = error instanceof Error ? error.message : String(error);
                  recordToolError(runTracker, name, error);
                  yield* logger.error("Tool execution failed", {
                    agentId: agent.id,
                    conversationId: actualConversationId,
                    toolName: name,
                    toolCallId: toolCall.id,
                    error: errorMessage,
                  });

                  // Include the tool execution error in the conversation
                  currentMessages.push({
                    role: "tool",
                    name,
                    content: `Error: ${errorMessage}`,
                    tool_call_id: toolCall.id,
                  });

                  // Store the error
                  toolResults[name] = {
                    error: errorMessage,
                  };
                }
              }
            }

            // Update the response with tool results
            response = { ...response, toolCalls: completion.toolCalls, toolResults };

            // Continue the conversation with the tool results
            continue;
          }

          // No tool calls, we have the final response
          response = { ...response, content: formattedContent };

          // Log completion
          const completionMessage = MarkdownRenderer.formatCompletion(agent.name);
          yield* logger.info(completionMessage, {
            agentId: agent.id,
            conversationId: actualConversationId,
            totalIterations: i + 1,
            hasContent: !!completion.content,
          });

          // Show metrics if enabled
          if (showMetrics && completion.usage) {
            const parts: string[] = [];
            if (completion.usage.totalTokens) {
              parts.push(`Total: ${completion.usage.totalTokens} tokens`);
            }
            if (completion.usage.promptTokens) {
              parts.push(`Prompt: ${completion.usage.promptTokens}`);
            }
            if (completion.usage.completionTokens) {
              parts.push(`Completion: ${completion.usage.completionTokens}`);
            }
            if (parts.length > 0) {
              yield* logger.info(`[${parts.join(" | ")}]`, {
                agentId: agent.id,
                conversationId: actualConversationId,
              });
            }
          }

          // Mark loop as finished and break
          iterationsUsed = i + 1;
          finished = true;
          break;
        } finally {
          yield* Effect.sync(() => completeIteration(runTracker));
        }
      }

      // Post-loop diagnostics
      if (!finished) {
        iterationsUsed = maxIterations;
        const warningMessage = MarkdownRenderer.formatWarning(
          agent.name,
          `reached maximum iterations (${maxIterations})`,
        );
        yield* logger.warn(warningMessage, {
          agentId: agent.id,
          conversationId: actualConversationId,
          maxIterations,
        });
      } else if (
        (!response.content || response.content.trim().length === 0) &&
        !response.toolCalls
      ) {
        const emptyMessage = MarkdownRenderer.formatWarning(
          agent.name,
          "model returned an empty response",
        );
        yield* logger.warn(emptyMessage, {
          agentId: agent.id,
          conversationId: actualConversationId,
          totalIterations: iterationsUsed,
        });
      }

      yield* finalizeAgentRun(runTracker, {
        iterationsUsed,
        finished,
      }).pipe(
        Effect.catchAll((error) =>
          logger.warn("Failed to write agent token usage log", {
            agentId: agent.id,
            conversationId: actualConversationId,
            error: error.message,
          }),
        ),
      );

      // Optionally persist conversation history via a storage layer in the future

      // Return the full message history from this turn so callers can persist it
      // Mark as not streamed since we used non-streaming mode
      return { ...response, messages: currentMessages, wasStreamed: false };
    });
  }
}

/**
 * Execute a tool by name with the provided arguments
 *
 * Finds the specified tool in the registry and executes it with the given arguments
 * and context. Provides comprehensive logging of the execution process including
 * start, success, and error states.
 *
 * @param name - The name of the tool to execute
 * @param args - The arguments to pass to the tool
 * @param context - The execution context containing agent and conversation information
 * @returns An Effect that resolves to the tool execution result
 *
 * @throws {Error} When the tool is not found or execution fails
 *
 * @example
 * ```typescript
 * const result = yield* executeTool(
 *   "gmail_list_emails",
 *   { query: "is:unread" },
 *   { agentId: "agent-123", conversationId: "conv-456" }
 * );
 * ```
 */
export function executeTool(
  name: string,
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Effect.Effect<ToolExecutionResult, Error, ToolRegistry | LoggerService | ConfigService> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    return yield* registry.executeTool(name, args, context);
  });
}
