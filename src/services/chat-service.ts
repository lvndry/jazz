import { FileSystem } from "@effect/platform";
import { Effect, Layer } from "effect";
import { AgentRunner, type AgentRunnerOptions } from "../core/agent/agent-runner";
import { AgentConfigServiceTag } from "../core/interfaces/agent-config";
import { AgentServiceTag, type AgentService } from "../core/interfaces/agent-service";
import { ChatServiceTag, type ChatService } from "../core/interfaces/chat-service";
import { FileSystemContextServiceTag, type FileSystemContextService } from "../core/interfaces/fs";
import { type LLMService } from "../core/interfaces/llm";
import { LoggerServiceTag, type LoggerService } from "../core/interfaces/logger";
import { MCPServerManagerTag, type MCPServerManager } from "../core/interfaces/mcp-server";
import { type PresentationService } from "../core/interfaces/presentation";
import { TerminalServiceTag, type TerminalService } from "../core/interfaces/terminal";
import {
    ToolRegistryTag,
    type ToolRegistry,
    type ToolRequirements,
} from "../core/interfaces/tool-registry";
import {
    LLMAuthenticationError,
    LLMRateLimitError,
    LLMRequestError,
} from "../core/types/errors";
import type { Agent } from "../core/types/index";
import { type ChatMessage } from "../core/types/message";
import { handleSpecialCommand, parseSpecialCommand } from "./chat/commands";
import {
    generateConversationId,
    generateSessionId,
    initializeSession,
    logMessageToSession,
    setupAgent,
    updateWorkingDirectoryInStore,
} from "./chat/session";

/**
 * Chat service implementation for managing interactive chat sessions with AI agents
 */
export class ChatServiceImpl implements ChatService {
  startChatSession(
    agent: Agent,
    options?: {
      stream?: boolean;
    },
  ): Effect.Effect<
    void,
    never,
    | TerminalService
    | LoggerService
    | FileSystemContextService
    | FileSystem.FileSystem
    | typeof AgentConfigServiceTag
    | ToolRegistry
    | AgentService
    | LLMService
    | PresentationService
    | MCPServerManager
    | ToolRequirements
  > {
    return Effect.gen(function* () {
      const terminal = yield* TerminalServiceTag;
      const logger = yield* LoggerServiceTag;

      const sessionId = generateSessionId(agent.name);

      yield* logger.setSessionId(sessionId);

      // Generate initial conversationId
      let conversationId: string = generateConversationId();

      // Initialize session before the loop
      const fileSystemContext = yield* FileSystemContextServiceTag;
      yield* initializeSession(agent, conversationId).pipe(
        Effect.catchAll(() =>
          Effect.gen(function* () {
            yield* logger.error("Session initialization error");
          }),
        ),
      );
      // Update working directory in store after initialization
      updateWorkingDirectoryInStore(agent.id, conversationId, fileSystemContext);

      // Agent setup phase: Connect to MCP servers and register tools before first message
      // Errors are handled gracefully inside setupAgent - conversation continues even if some MCPs fail
      yield* setupAgent(agent, sessionId);

      let chatActive = true;
      let conversationHistory: ChatMessage[] = [];
      let loggedMessageCount = 0;

      while (chatActive) {
        // Prompt for user input
        const userMessage = yield* terminal.ask("You:").pipe(
          Effect.catchAll((error: unknown) => {
            // Handle ExitPromptError from inquirer when user presses Ctrl+C
            if (
              error instanceof Error &&
              (error.name === "ExitPromptError" || error.message.includes("SIGINT"))
            ) {
              // Exit gracefully on Ctrl+C - return /exit to trigger normal exit flow
              // The exit check below will handle the goodbye message and cleanup
              return Effect.succeed("/exit");
            }
            // Re-throw other errors, ensuring it's an Error instance
            return Effect.fail(error instanceof Error ? error : new Error(String(error)));
          }),
        );

        const trimmedMessage = userMessage.trim();
        const lowerMessage = trimmedMessage.toLowerCase();
        if (lowerMessage === "/exit" || lowerMessage === "exit" || lowerMessage === "quit") {
          yield* terminal.info("👋 Goodbye!");

          // Cleanup: Disconnect all MCP servers before exiting
          // This ensures child processes are properly terminated
          try {
            const mcpManager = yield* MCPServerManagerTag;
            yield* mcpManager.disconnectAllServers().pipe(
              Effect.catchAll((error) =>
                Effect.gen(function* () {
                  const logger = yield* LoggerServiceTag;
                  const errorMessage = error instanceof Error ? error.message : String(error);
                  yield* logger.debug(`Error during MCP cleanup: ${errorMessage}`);
                  // Continue with exit even if cleanup fails
                }),
              ),
            );
          } catch {
            // Ignore errors during cleanup - we're exiting anyway
          }

          chatActive = false;
          continue;
        }

        if (!userMessage || trimmedMessage.length === 0) {
          yield* terminal.log(
            "(Tip) Type a message and press Enter, '/help' for commands, or '/exit' to quit.",
          );
          continue;
        }

        if (trimmedMessage.startsWith("/")) {
          const specialCommand = parseSpecialCommand(userMessage);
          const commandResult = yield* handleSpecialCommand(specialCommand, {
            agent,
            conversationId,
            conversationHistory,
            sessionId,
          });

          if (commandResult.newConversationId !== undefined) {
            conversationId = commandResult.newConversationId;
            // Initialize the new conversation
            const fileSystemContext = yield* FileSystemContextServiceTag;
            yield* initializeSession(agent, conversationId).pipe(
              Effect.catchAll(() =>
                Effect.gen(function* () {
                  yield* logger.error("Session initialization error");
                }),
              ),
            );
            // Update working directory in store after conversation change
            updateWorkingDirectoryInStore(agent.id, conversationId, fileSystemContext);
          }
          if (commandResult.newAgent !== undefined) {
            agent = commandResult.newAgent;
            // Update working directory in store after agent switch
            const fileSystemContext = yield* FileSystemContextServiceTag;
            updateWorkingDirectoryInStore(agent.id, conversationId, fileSystemContext);
          }
          if (commandResult.newHistory !== undefined) {
            conversationHistory = commandResult.newHistory;
            // Reset logged message count when history is cleared (e.g., /new command)
            loggedMessageCount = 0;
          }

          continue;
        }

        yield* Effect.gen(function* () {
          // Create runner options
          const runnerOptions: AgentRunnerOptions = {
            agent,
            userInput: userMessage,
            conversationId,
            sessionId, // Pass the sessionId for logging
            conversationHistory,
            ...(options?.stream !== undefined ? { stream: options.stream } : {}),
          };

          // Run the agent with proper error handling
          const response = yield* AgentRunner.run(runnerOptions).pipe(
            Effect.catchAll((error) =>
              Effect.gen(function* () {
                // Log error with detailed information
                const errorDetails: Record<string, unknown> = {
                  agentId: agent.id,
                  conversationId: conversationId || undefined,
                  errorMessage: String(error),
                };

                if (
                  error instanceof LLMRateLimitError ||
                  error instanceof LLMRequestError ||
                  error instanceof LLMAuthenticationError
                ) {
                  errorDetails["errorType"] = error._tag;
                  errorDetails["provider"] = error.provider;
                }

                if (error instanceof Error && error.stack) {
                  errorDetails["stack"] = error.stack;
                }

                yield* logger.error("Agent execution error", errorDetails);

                yield* terminal.log("");

                // Handle different error types with appropriate user feedback
                if (error instanceof LLMRateLimitError) {
                  yield* terminal.warn(
                    `Rate limit exceeded. The request was too large or you've hit your API limits.`,
                  );
                  yield* terminal.log(
                    "   Please try again in a moment or consider using a smaller context.",
                  );
                  yield* terminal.log(`   Error details: ${error.message}`);
                } else if (error instanceof LLMRequestError) {
                  // Extract clean error message without verbose details
                  const cleanMessage = error.message.split(" | ")[0] || error.message;
                  yield* terminal.error(`LLM request failed: ${cleanMessage}`);
                  yield* terminal.log("   This might be a temporary issue. Please try again.");
                } else {
                  yield* terminal.error(`Error: ${String(error)}`);
                }
                yield* terminal.log("");

                // Return a minimal response to allow the loop to continue
                return {
                  conversationId: conversationId || "",
                  messages: conversationHistory,
                  content: "",
                };
              }),
            ),
          );

          // Store the conversation ID for continuity
          conversationId = response.conversationId;

          // Persist conversation history for next turn and log new messages
          if (response.messages) {
            // Log all new messages that haven't been logged yet
            const newMessages = response.messages.slice(loggedMessageCount);
            for (const message of newMessages) {
              yield* logMessageToSession(sessionId, message);
            }
            loggedMessageCount = response.messages.length;
            conversationHistory = response.messages;
          } else if (response.content) {
            // If we have content but no messages array, log both user and assistant messages
            const userChatMessage: ChatMessage = {
              role: "user",
              content: userMessage,
            };
            yield* logMessageToSession(sessionId, userChatMessage);

            const assistantMessage: ChatMessage = {
              role: "assistant",
              content: response.content,
            };
            yield* logMessageToSession(sessionId, assistantMessage);
            loggedMessageCount += 2; // user message + assistant message
          } else {
            // If no messages array and no content, still log the user message
            const userChatMessage: ChatMessage = {
              role: "user",
              content: userMessage,
            };
            yield* logMessageToSession(sessionId, userChatMessage);
            loggedMessageCount += 1;
          }

          // Display is handled entirely by AgentRunner (both streaming and non-streaming)
          // No need to display here - AgentRunner takes care of it

          // Update working directory in store after agent run (in case cd was called)
          const fileSystemContext = yield* FileSystemContextServiceTag;
          updateWorkingDirectoryInStore(agent.id, conversationId, fileSystemContext);
        });
      }
    }).pipe(Effect.catchAll(() => Effect.void));
  }
}

/**
 * Create the chat service layer
 */
export function createChatServiceLayer(): Layer.Layer<
  ChatService,
  never,
  | TerminalService
  | LoggerService
  | FileSystemContextService
  | FileSystem.FileSystem
  | typeof AgentConfigServiceTag
  | typeof ToolRegistryTag
  | typeof AgentServiceTag
> {
  return Layer.succeed(ChatServiceTag, new ChatServiceImpl());
}
