import { Effect, Schedule } from "effect";

import { AgentConfigService, type ConfigService } from "../../services/config";
import {
  LLMRateLimitError,
  LLMServiceTag,
  type ChatMessage,
  type LLMService,
  type ToolCall,
} from "../../services/llm/types";
import { LoggerServiceTag, type LoggerService } from "../../services/logger";
import { type Agent } from "../types";
import { MarkdownRenderer } from "../utils/markdown-renderer";
import { agentPromptBuilder } from "./agent-prompt";
import {
  ToolRegistryTag,
  type ToolExecutionContext,
  type ToolExecutionResult,
  type ToolRegistry,
} from "./tools/tool-registry";
import {
  createAgentRunTracker,
  finalizeAgentRun,
  recordLLMRetry,
  recordLLMUsage,
  recordToolError,
  recordToolInvocation,
} from "./tracking/agent-run-tracker";

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
      const { agent, userInput, conversationId, userId, maxIterations = 8 } = options;

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
      const agentToolNames = agent.config.tools
        ? Object.values(agent.config.tools)
            .flat()
            .filter((tool): tool is string => typeof tool === "string")
        : [];

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
                recordToolError(runTracker, error);
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
