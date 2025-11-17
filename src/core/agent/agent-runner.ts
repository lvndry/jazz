import chalk from "chalk";
import { Cause, Duration, Effect, Exit, Fiber, Option, Ref, Schedule, Stream } from "effect";

import { MAX_AGENT_STEPS } from "../../constants/agent";
import { AgentConfigService, type ConfigService } from "../../services/config";
import { LLMService, LLMServiceTag } from "../../services/llm/interfaces";
import { ChatMessage } from "../../services/llm/messages";
import { ChatCompletionResponse } from "../../services/llm/models";
import { shouldEnableStreaming } from "../../services/llm/stream-detector";
import type { StreamEvent } from "../../services/llm/streaming-types";
import { ToolCall, ToolDefinition } from "../../services/llm/tools";
import { LoggerServiceTag, type LoggerService } from "../../services/logger";
import type { StreamingConfig } from "../types";
import { type Agent } from "../types";
import { LLMAuthenticationError, LLMRateLimitError, LLMRequestError } from "../types/errors";
import { MarkdownRenderer } from "../utils/markdown-renderer";
import {
  OutputRenderer,
  type DisplayConfig,
  type OutputRendererConfig,
} from "../utils/output-renderer";
import { formatToolArguments } from "../utils/tool-formatter";
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
  recordFirstTokenLatency,
  recordLLMRetry,
  recordLLMUsage,
  recordToolError,
  recordToolInvocation,
} from "./tracking/agent-run-tracker";
import { normalizeToolConfig } from "./utils/tool-config";

const MAX_MESSAGES = 100;
const MAX_RETRIES = 3;
const STREAM_CREATION_TIMEOUT = Duration.minutes(2);
const DEFERRED_RESPONSE_TIMEOUT = Duration.seconds(15);

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
   * Override streaming behavior (from --stream or --no-stream CLI flags).
   * - `true`: Force streaming on
   * - `false`: Force streaming off
   * - `undefined`: Use auto-detection (default)
   */
  readonly stream?: boolean;
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
}

/**
 * Default display configuration (applies to both modes)
 */
const DEFAULT_DISPLAY_CONFIG: DisplayConfig = {
  showThinking: true,
  showToolExecution: true,
  mode: "normal",
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
  readonly provider: string;
  readonly model: string;
}

/**
 * Initialize common agent run context (tools, messages, tracker)
 */
function initializeAgentRun(
  options: AgentRunnerOptions,
): Effect.Effect<
  AgentRunContext,
  Error,
  ToolRegistry | LoggerService | ConfigService
> {
  return Effect.gen(function* () {
    const { agent, userInput, conversationId, userId } = options;
    const toolRegistry = yield* ToolRegistryTag;

    const actualConversationId = conversationId || `conv-${Date.now()}`;
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
    const tools = Array.from(allTools.filter((tool) => expandedToolNames.includes(tool.function.name)));

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

    const context: ToolExecutionContext = {
      agentId: agent.id,
      conversationId: actualConversationId,
      ...(userId ? { userId } : {}),
    };

    return {
      agent,
      actualConversationId,
      context,
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
 * Execute a single tool call and return result
 */
function executeToolCall(
  toolCall: ToolCall,
  context: ToolExecutionContext,
  displayConfig: DisplayConfig,
  renderer: OutputRenderer | null,
  runTracker: ReturnType<typeof createAgentRunTracker>,
  logger: LoggerService,
  agentId: string,
  conversationId: string,
): Effect.Effect<
  { result: unknown; success: boolean },
  Error,
  ToolRegistry | LoggerService | ConfigService
> {
  return Effect.gen(function* () {
    if (toolCall.type !== "function") {
      return { result: null, success: false };
    }

    const { name, arguments: argsString } = toolCall.function;
    recordToolInvocation(runTracker, name);
    const toolStartTime = Date.now();

    try {
      // Parse arguments
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

      // Emit tool execution start
      if (displayConfig.showToolExecution) {
        if (renderer) {
          yield* renderer.handleEvent({
            type: "tool_execution_start",
            toolName: name,
            toolCallId: toolCall.id,
            arguments: args,
          });
        } else {
          const argsStr = OutputRenderer.formatToolArguments(name, args);
          process.stdout.write(
            `\n${chalk.cyan("⚙️")}  Executing tool: ${chalk.cyan(name)}${argsStr}...`,
          );
        }
      }

      // Execute tool
      const result = yield* executeTool(name, args, context);
      const toolDuration = Date.now() - toolStartTime;
      const resultString = JSON.stringify(result.result);

      // Emit tool execution complete
      if (displayConfig.showToolExecution) {
        if (renderer) {
          yield* renderer.handleEvent({
            type: "tool_execution_complete",
            toolCallId: toolCall.id,
            result: resultString,
            durationMs: toolDuration,
          });
        } else {
          if (result.success) {
            const summary = OutputRenderer.formatToolResult(name, resultString);
            process.stdout.write(
              ` ${chalk.green("✓")}${summary ? ` ${summary}` : ""} ${chalk.dim(`(${toolDuration}ms)`)}\n`,
            );
          } else {
            const errorMsg = result.error || "Tool execution failed";
            process.stdout.write(
              ` ${chalk.red("✗")} ${chalk.red(`(${errorMsg})`)} ${chalk.dim(`(${toolDuration}ms)`)}\n`,
            );
          }
        }
      }

      return { result: result.result, success: result.success };
    } catch (error) {
      // Fail fast on missing tools
      if (error instanceof Error && error.message.startsWith("Tool not found")) {
        throw error;
      }

      const toolDuration = Date.now() - toolStartTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Emit error
      if (displayConfig.showToolExecution) {
        if (renderer) {
          yield* renderer.handleEvent({
            type: "tool_execution_complete",
            toolCallId: toolCall.id,
            result: `Error: ${errorMessage}`,
            durationMs: toolDuration,
          });
        } else {
          process.stdout.write(
            ` ${chalk.red("✗")} ${chalk.red(`(${errorMessage})`)} ${chalk.dim(`(${toolDuration}ms)`)}\n`,
          );
        }
      }

      recordToolError(runTracker, name, error);
      yield* logger.error("Tool execution failed", {
        agentId,
        conversationId,
        toolName: name,
        toolCallId: toolCall.id,
        error: errorMessage,
      });

      return { result: { error: errorMessage }, success: false };
    }
  });
}

/**
 * Execute all tool calls and return results
 */
function executeToolCalls(
  toolCalls: readonly ToolCall[],
  context: ToolExecutionContext,
  displayConfig: DisplayConfig,
  renderer: OutputRenderer | null,
  runTracker: ReturnType<typeof createAgentRunTracker>,
  logger: LoggerService,
  agentId: string,
  conversationId: string,
  agentName: string,
): Effect.Effect<
  Record<string, unknown>,
  Error,
  ToolRegistry | LoggerService | ConfigService
> {
  return Effect.gen(function* () {
    const toolResults: Record<string, unknown> = {};
    const toolNames = toolCalls.map((tc) => tc.function.name);

    // Show tools detected
    if (displayConfig.showToolExecution) {
      if (renderer) {
        yield* renderer.handleEvent({
          type: "tools_detected",
          toolNames,
          agentName,
        });
      } else {
        const tools = toolNames.join(", ");
        console.log(
          `\n${chalk.yellow("🔧")} ${chalk.yellow(agentName)} is using tools: ${chalk.cyan(tools)}\n`,
        );
      }
    }

    // Log tool details
    const toolDetails: string[] = [];
    for (const toolCall of toolCalls) {
      if (toolCall.type === "function") {
        const { name, arguments: argsString } = toolCall.function;
        try {
          const parsed: unknown = JSON.parse(argsString);
          const args: Record<string, unknown> =
            parsed && typeof parsed === "object" && !Array.isArray(parsed)
              ? (parsed as Record<string, unknown>)
              : {};
          const argsText = formatToolArguments(name, args, { style: "plain" });
          toolDetails.push(argsText ? `${name} ${argsText}` : name);
        } catch {
          toolDetails.push(name);
        }
      }
    }
    const toolsList = toolDetails.join(", ");
    yield* logger.info(`${agentName} is using tools: ${toolsList}`);

    // Execute each tool
    for (const toolCall of toolCalls) {
      const { result } = yield* executeToolCall(
        toolCall,
        context,
        displayConfig,
        renderer,
        runTracker,
        logger,
        agentId,
        conversationId,
      );
      toolResults[toolCall.function.name] = result;
    }

    return toolResults;
  });
}

/**
 * Trim message history to prevent unbounded growth.
 * Always preserves the system message (first message) and keeps the most recent messages.
 */
function trimMessages(
  messages: ChatMessage[],
  logger: LoggerService,
  agentId: string,
  conversationId: string,
): Effect.Effect<void, never, LoggerService | ConfigService> {
  if (messages.length > MAX_MESSAGES) {
    // Always preserve the system message (first message) as it contains important context
    const systemMessage = messages[0];
    if (systemMessage) {
      // Keep system message + most recent (MAX_MESSAGES - 1) messages
      const recentMessages = messages.slice(-(MAX_MESSAGES - 1));
      messages.length = 0;
      messages.push(systemMessage, ...recentMessages);
    }

    return logger.warn("Message history trimmed to prevent memory issues", {
      agentId,
      conversationId,
      maxMessages: MAX_MESSAGES,
      trimmedCount: messages.length,
    });
  }

  return Effect.void;
}

/**
 * Ensure messages array is never empty
 */
function ensureMessagesNotEmpty(
  messages: ChatMessage[],
  userInput: string,
  logger: LoggerService,
  agentId: string,
  conversationId: string,
  iteration: number,
): Effect.Effect<ChatMessage[], never, LoggerService | ConfigService> {
  if (messages.length === 0) {
    return Effect.gen(function* () {
      yield* logger.warn("messagesToSend was empty; using fallback single user message", {
        agentId,
        conversationId,
        iteration,
      });
      return [
        {
          role: "user",
          content: userInput && userInput.trim().length > 0 ? userInput : "Continue",
        },
      ];
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
    LLMService | ToolRegistry | LoggerService | ConfigService
  > {
    return Effect.gen(function* () {
      // Get services
      const configService = yield* AgentConfigService;
      const appConfig = yield* configService.appConfig;

      // Determine if streaming should be enabled
      const streamDetection = shouldEnableStreaming(
        appConfig,
        options.stream !== undefined ? { stream: options.stream } : {},
      );

      // Get display config with defaults (applies to both modes)
      const displayConfig: DisplayConfig = {
        showThinking: appConfig.output?.showThinking ?? DEFAULT_DISPLAY_CONFIG.showThinking,
        showToolExecution:
          appConfig.output?.showToolExecution ?? DEFAULT_DISPLAY_CONFIG.showToolExecution,
        mode: appConfig.output?.mode ?? DEFAULT_DISPLAY_CONFIG.mode,
        colorProfile: appConfig.output?.colorProfile,
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
    LLMService | ToolRegistry | LoggerService | ConfigService
  > {
    return Effect.gen(function* () {
      const { agent, userInput, maxIterations = MAX_AGENT_STEPS } = options;
      const llmService = yield* LLMServiceTag;
      const logger = yield* LoggerServiceTag;

      // Initialize common context
      const runContext = yield* initializeAgentRun(options);
      const { actualConversationId, context, tools, messages, runTracker, provider, model } =
        runContext;

      // Create renderer
      const normalizedStreamingConfig: StreamingConfig = {
        enabled: true, // Always enabled in streaming mode
        ...(streamingConfig.progressiveMarkdown !== undefined && {
          progressiveMarkdown: streamingConfig.progressiveMarkdown,
        }),
        ...(streamingConfig.textBufferMs !== undefined && {
          textBufferMs: streamingConfig.textBufferMs,
        }),
      };
      const rendererConfig: OutputRendererConfig = {
        displayConfig,
        streamingConfig: normalizedStreamingConfig,
        showMetrics,
        agentName: agent.name,
        reasoningEffort: agent.config.reasoningEffort,
      };
      const renderer = new OutputRenderer(rendererConfig);

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
            yield* logger.info(MarkdownRenderer.formatThinking(agent.name, true));
          } else {
            yield* logger.info(MarkdownRenderer.formatThinking(agent.name, false));
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

          const completionRef = yield* Ref.make<ChatCompletionResponse | undefined>(undefined);
          const pendingToolCalls: ToolCall[] = [];

          const streamingResult = yield* Effect.retry(
            Effect.gen(function* () {
              try {
                return yield* llmService.createStreamingChatCompletion(provider, llmOptions);
              } catch (error) {
                recordLLMRetry(runTracker, error);
                // Log LLM error details
                if (error instanceof LLMRequestError || error instanceof LLMRateLimitError || error instanceof LLMAuthenticationError) {
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
                if (error instanceof LLMRequestError || error instanceof LLMRateLimitError || error instanceof LLMAuthenticationError) {
                  yield* logger.error("Streaming failed, falling back to non-streaming mode", {
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

                if (event.type === "tool_call") {
                  pendingToolCalls.push(event.toolCall);
                }

                if (event.type === "complete") {
                  yield* Ref.set(completionRef, event.response);
                  if (event.metrics?.firstTokenLatencyMs) {
                    recordFirstTokenLatency(runTracker, event.metrics.firstTokenLatencyMs);
                  }
                }

                if (event.type === "error") {
                  // Log the error
                  const error = event.error as LLMAuthenticationError | LLMRateLimitError | LLMRequestError;
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

          // Get completion from stream or fallback
          let completion: ChatCompletionResponse;
          if (Exit.isFailure(streamExit)) {
            yield* streamingResult.cancel;
            const error = Cause.failureOption(streamExit.cause);
            if (Option.isSome(error)) {
              yield* logger.warn("Stream processing failed, using fallback");
              completion = yield* llmService.createChatCompletion(provider, llmOptions);
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

          if (completion.usage) {
            recordLLMUsage(runTracker, completion.usage);
          }

          // Add assistant response to conversation
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

          yield* trimMessages(currentMessages, logger, agent.id, actualConversationId);

          // Handle tool calls
          if (completion.toolCalls && completion.toolCalls.length > 0) {
            const toolResults = yield* executeToolCalls(
              completion.toolCalls,
              context,
              displayConfig,
              renderer,
              runTracker,
              logger,
              agent.id,
              actualConversationId,
              agent.name,
            );

            // Add tool results to conversation
            for (const toolCall of completion.toolCalls) {
              if (toolCall.type === "function") {
                const result = toolResults[toolCall.function.name];
                currentMessages.push({
                  role: "tool",
                  name: toolCall.function.name,
                  content: JSON.stringify(result),
                  tool_call_id: toolCall.id,
                });
              }
            }

            response = { ...response, toolCalls: completion.toolCalls, toolResults };
            continue;
          }

          // No tool calls - final response
          response = { ...response, content: completion.content };
          yield* logger.info(MarkdownRenderer.formatCompletion(agent.name));

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
        yield* logger.warn(
          MarkdownRenderer.formatWarning(
            agent.name,
            `reached maximum iterations (${maxIterations}) - type 'resume' to continue`,
          ),
        );
      } else if (!response.content?.trim() && !response.toolCalls) {
        yield* logger.warn(
          MarkdownRenderer.formatWarning(agent.name, "model returned an empty response"),
        );
      }

      // Finalize run asynchronously
      yield* finalizeAgentRun(runTracker, { iterationsUsed, finished }).pipe(
        Effect.catchAll((error) =>
          logger.warn("Failed to write agent token usage log", { error: error.message }),
        ),
        Effect.fork,
        Effect.asVoid,
      );

      return { ...response, messages: currentMessages };
    });
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
    LLMService | ToolRegistry | LoggerService | ConfigService
  > {
    return Effect.gen(function* () {
      const { agent, userInput, maxIterations = MAX_AGENT_STEPS } = options;
      const llmService = yield* LLMServiceTag;
      const logger = yield* LoggerServiceTag;

      // Initialize common context
      const runContext = yield* initializeAgentRun(options);
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
              yield* logger.info(MarkdownRenderer.formatThinking(agent.name, true));
            } else {
              yield* logger.info(MarkdownRenderer.formatThinking(agent.name, false));
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

          if (completion.usage) {
            recordLLMUsage(runTracker, completion.usage);
          }

          // Add assistant response to conversation
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

          yield* trimMessages(currentMessages, logger, agent.id, actualConversationId);

          // Format content - always use markdown since LLMs output markdown
          let formattedContent = completion.content;
          if (formattedContent) {
            formattedContent = MarkdownRenderer.render(formattedContent);
          }

          // Handle tool calls
          if (completion.toolCalls && completion.toolCalls.length > 0) {
            const toolResults = yield* executeToolCalls(
              completion.toolCalls,
              context,
              displayConfig,
              null, // No renderer for non-streaming
              runTracker,
              logger,
              agent.id,
              actualConversationId,
              agent.name,
            );

            // Add tool results to conversation
            for (const toolCall of completion.toolCalls) {
              if (toolCall.type === "function") {
                const result = toolResults[toolCall.function.name];
                currentMessages.push({
                  role: "tool",
                  name: toolCall.function.name,
                  content: JSON.stringify(result),
                  tool_call_id: toolCall.id,
                });
              }
            }

            response = { ...response, toolCalls: completion.toolCalls, toolResults };
            continue;
          }

          // No tool calls - final response
          response = { ...response, content: formattedContent };

          // Display final response
          if (formattedContent && formattedContent.trim().length > 0) {
            console.log();
            console.log(MarkdownRenderer.formatAgentResponse(agent.name, formattedContent));
            console.log();
          }

          yield* logger.info(MarkdownRenderer.formatCompletion(agent.name));

          // Show metrics if enabled
          if (showMetrics && completion.usage) {
            const parts: string[] = [];
            if (completion.usage.totalTokens) parts.push(`Total: ${completion.usage.totalTokens} tokens`);
            if (completion.usage.promptTokens) parts.push(`Prompt: ${completion.usage.promptTokens}`);
            if (completion.usage.completionTokens) parts.push(`Completion: ${completion.usage.completionTokens}`);
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
        yield* logger.warn(
          MarkdownRenderer.formatWarning(
            agent.name,
            `reached maximum iterations (${maxIterations}) - type 'resume' to continue`,
          ),
        );
      } else if (!response.content?.trim() && !response.toolCalls) {
        yield* logger.warn(
          MarkdownRenderer.formatWarning(agent.name, "model returned an empty response"),
        );
      }

      // Finalize run asynchronously
      yield* finalizeAgentRun(runTracker, { iterationsUsed, finished }).pipe(
        Effect.catchAll((error) =>
          logger.warn("Failed to write agent token usage log", { error: error.message }),
        ),
        Effect.fork,
        Effect.asVoid,
      );

      return { ...response, messages: currentMessages };
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
