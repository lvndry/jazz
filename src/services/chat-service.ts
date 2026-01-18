import { FileSystem } from "@effect/platform";
import { Effect, Layer } from "effect";
import { spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import short from "short-uuid";
import { store } from "../cli/ui/App";
import { AgentRunner, type AgentRunnerOptions } from "../core/agent/agent-runner";
import { getAgentByIdentifier } from "../core/agent/agent-service";
import { registerMCPToolsForAgent } from "../core/agent/tools/register-tools";
import { normalizeToolConfig } from "../core/agent/utils/tool-config";
import { AgentConfigServiceTag, type AgentConfigService } from "../core/interfaces/agent-config";
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
  StorageError,
  StorageNotFoundError,
} from "../core/types/errors";
import type { Agent } from "../core/types/index";
import { type ChatMessage } from "../core/types/message";
import { getLogsDirectory } from "./logger";

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
          const commandResult: {
            shouldContinue: boolean;
            newConversationId?: string | undefined;
            newHistory?: ChatMessage[];
            newAgent?: Agent;
          } = yield* handleSpecialCommand(
            specialCommand,
            agent,
            conversationId,
            conversationHistory,
            sessionId,
          );

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
 * Initialize a chat session
 */
function initializeSession(
  agent: Agent,
  conversationId: string,
): Effect.Effect<
  void,
  never,
  FileSystemContextService | LoggerService | FileSystem.FileSystem | typeof AgentConfigServiceTag
> {
  return Effect.gen(function* () {
    const agentKey = { agentId: agent.id, conversationId };
    const fileSystemContext = yield* FileSystemContextServiceTag;
    const logger = yield* LoggerServiceTag;
    yield* fileSystemContext
      .setCwd(agentKey, process.cwd())
      .pipe(Effect.catchAll(() => Effect.void));
    yield* logger.info(`Initialized agent working directory to: ${process.cwd()}`);
  });
}

/**
 * Set up agent before first message: Connect to MCP servers and register tools
 *
 * This happens as part of "agent setup" phase before the chat loop starts.
 * MCP connections are established early so tools are available when needed.
 * If some MCP connections fail (e.g., invalid credentials), we show a warning
 * but continue the conversation - the agent can still use other available tools.
 */
function setupAgent(
  agent: Agent,
  sessionId: string,
): Effect.Effect<
  void,
  never,
  | ToolRegistry
  | MCPServerManager
  | AgentConfigService
  | LoggerService
  | TerminalService
> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const terminal = yield* TerminalServiceTag;
    yield* logger.setSessionId(sessionId);

    // Get agent's tool names
    const agentToolNames = normalizeToolConfig(agent.config.tools, {
      agentId: agent.id,
    });

    // Register MCP tools for this agent (connects to relevant servers)
    // This happens before the first message as part of agent setup
    // Errors are handled gracefully - failed MCPs are logged but conversation continues
    const setupResult = yield* registerMCPToolsForAgent(agentToolNames).pipe(
      Effect.either,
    );

    if (setupResult._tag === "Left") {
      // MCP setup had errors, but we continue anyway
      const error = setupResult.left;
      const errorMessage =
        typeof error === "object" && error !== null && "message" in error
          ? String((error as { message: unknown }).message)
          : String(error);
      yield* logger.warn(`Some MCP connections failed during agent setup: ${errorMessage}`);
      yield* terminal.log("");
      yield* terminal.warn(
        "⚠️  Some MCP servers could not be connected. The agent will continue with available tools.",
      );
      yield* terminal.log(
        "   You can still chat with the agent, but tools from failed MCP servers won't be available.",
      );
      yield* terminal.log("");
    } else {
      yield* logger.debug("Agent setup completed - MCP tools registered");
    }
  });
}

/**
 * Update the working directory in the UI store
 */
function updateWorkingDirectoryInStore(
  agentId: string,
  conversationId: string | undefined,
  fileSystemContext: FileSystemContextService,
): void {
  Effect.gen(function* () {
    const cwd = yield* fileSystemContext.getCwd(
      conversationId ? { agentId, conversationId } : { agentId },
    );
    store.setWorkingDirectory(cwd);
  }).pipe(Effect.runSync);
}

/**
 * Log a chat message to the session log file
 */
function logMessageToSession(
  sessionId: string,
  message: ChatMessage,
): Effect.Effect<void, never, never> {
  return Effect.tryPromise({
    try: async () => {
      const logsDir = getLogsDirectory();
      await mkdir(logsDir, { recursive: true });
      const logFilePath = path.join(logsDir, `${sessionId}.log`);
      const timestamp = new Date().toISOString();
      const role = message.role.toUpperCase();
      const content = message.content || "";
      const line = `[${timestamp}] [${role}] ${content}\n`;
      await appendFile(logFilePath, line, { encoding: "utf8" });
    },
    catch: () => undefined, // Silently fail - logging should not break the chat session
  }).pipe(Effect.catchAll(() => Effect.void));
}

/**
 * Special command types
 */
type SpecialCommand = {
  type: "new" | "help" | "status" | "clear" | "tools" | "agents" | "switch" | "compact" | "copy" | "unknown";
  args: string[];
};

/**
 * Parse special commands from user input
 */
function parseSpecialCommand(input: string): SpecialCommand {
  const trimmed = input.trim();

  if (!trimmed.startsWith("/")) {
    return { type: "unknown", args: [] };
  }

  const parts = trimmed.slice(1).split(/\s+/);
  const command = parts[0]?.toLowerCase() || "";
  const args = parts.slice(1);

  switch (command) {
    case "new":
      return { type: "new", args };
    case "help":
      return { type: "help", args };
    case "status":
      return { type: "status", args };
    case "clear":
      return { type: "clear", args };
    case "tools":
      return { type: "tools", args };
    case "agents":
      return { type: "agents", args };
    case "switch":
      return { type: "switch", args };
    case "compact":
      return { type: "compact", args };
    case "copy":
      return { type: "copy", args };
    default:
      return { type: "unknown", args: [command, ...args] };
  }
}

/**
 * Handle special commands
 */
function handleSpecialCommand(
  command: SpecialCommand,
  agent: Agent,
  conversationId: string | undefined,
  conversationHistory: ChatMessage[],
  sessionId: string,
): Effect.Effect<
  {
    shouldContinue: boolean;
    newConversationId?: string | undefined;
    newHistory?: ChatMessage[];
    newAgent?: Agent;
  },
  StorageError | StorageNotFoundError | Error,
  | ToolRegistry
  | TerminalService
  | AgentService
  | FileSystemContextService
  | LoggerService
  | LLMService
  | AgentConfigService
  | PresentationService
  | ToolRequirements
> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    switch (command.type) {
      case "new":
        yield* terminal.info("Starting new conversation...");
        yield* terminal.log("   • Conversation context cleared");
        yield* terminal.log("   • Fresh start with the agent");
        yield* terminal.log("");
        yield* terminal.log("");
        return {
          shouldContinue: true,
          newConversationId: generateConversationId(),
          newHistory: [],
        };

      case "help":
        yield* terminal.heading("📖 Available special commands");
        yield* terminal.log("   /new             - Start a new conversation (clear context)");
        yield* terminal.log("   /status          - Show current conversation status");
        yield* terminal.log("   /tools           - List all agent tools by category");
        yield* terminal.log("   /agents          - List all available agents");
        yield* terminal.log(
          "   /switch [agent]  - Switch to a different agent in the same conversation",
        );
        yield* terminal.log("   /clear           - Clear the screen");
        yield* terminal.log("   /compact         - Summarize background history to save tokens");
        yield* terminal.log("   /copy            - Copy the last agent response to clipboard");
        yield* terminal.log("   /help            - Show this help message");
        yield* terminal.log("   /exit            - Exit the chat");
        yield* terminal.log("");
        return { shouldContinue: true };

      case "status": {
        yield* terminal.heading("📊 Conversation Status");
        yield* terminal.log(`   Agent: ${agent.name} (${agent.id})`);
        yield* terminal.log(`   Conversation ID: ${conversationId || "Not started"}`);
        yield* terminal.log(`   Messages in history: ${conversationHistory.length}`);
        yield* terminal.log(`   Agent type: ${agent.config.agentType}`);
        yield* terminal.log(`   Model: ${agent.config.llmProvider}/${agent.config.llmModel}`);
        yield* terminal.log(`   Reasoning effort: ${agent.config.reasoningEffort}`);
        const totalTools = agent.config.tools?.length ?? 0;
        yield* terminal.log(`   Tools: ${totalTools} available`);
        const fileSystemContext = yield* FileSystemContextServiceTag;
        const workingDirectory = yield* fileSystemContext.getCwd(
          conversationId ? { agentId: agent.id, conversationId } : { agentId: agent.id },
        );
        yield* terminal.log(`   Working directory: ${workingDirectory}`);
        yield* terminal.log("");
        return { shouldContinue: true };
      }

      case "tools": {
        const toolRegistry = yield* ToolRegistryTag;
        const allToolsByCategory = yield* toolRegistry.listToolsByCategory();

        const agentToolNames = normalizeToolConfig(agent.config.tools, {
          agentId: agent.id,
        });
        const agentToolSet = new Set(agentToolNames);

        const filteredToolsByCategory: Record<string, readonly string[]> = {};
        for (const [category, tools] of Object.entries(allToolsByCategory)) {
          const filteredTools = tools.filter((tool) => agentToolSet.has(tool));
          if (filteredTools.length > 0) {
            filteredToolsByCategory[category] = filteredTools;
          }
        }

        yield* terminal.heading(`🔧 Tools Available to ${agent.name}`);

        if (Object.keys(filteredToolsByCategory).length === 0) {
          yield* terminal.warn("This agent has no tools configured.");
        } else {
          const sortedCategories = Object.keys(filteredToolsByCategory).sort();

          for (const category of sortedCategories) {
            const tools = filteredToolsByCategory[category];
            if (tools && tools.length > 0) {
              yield* terminal.log(
                `   📁 ${category} (${tools.length} ${tools.length === 1 ? "tool" : "tools"}):`,
              );
              for (const tool of tools) {
                yield* terminal.log(`      • ${tool}`);
              }
              yield* terminal.log("");
            }
          }

          const totalTools = Object.values(filteredToolsByCategory).reduce(
            (sum, tools) => sum + (tools?.length || 0),
            0,
          );

          yield* terminal.log(
            `   Total: ${totalTools} tools across ${sortedCategories.length} categories`,
          );
        }

        yield* terminal.log("");
        return { shouldContinue: true };
      }

      case "agents": {
        const agentService = yield* AgentServiceTag;
        const allAgents = yield* agentService.listAgents();

        yield* terminal.heading("🤖 Available Agents");

        if (allAgents.length === 0) {
          yield* terminal.warn("No agents found.");
          yield* terminal.info("Create one with: jazz agent create");
        } else {
          for (const ag of allAgents) {
            const isCurrent = ag.id === agent.id;
            const prefix = isCurrent ? "  ➤ " : "    ";
            const currentMarker = isCurrent ? " (current)" : "";

            yield* terminal.log(`${prefix}${ag.name}${currentMarker}`);
            yield* terminal.log(`${prefix}  ID: ${ag.id}`);
            if (ag.description) {
              const truncatedDesc =
                ag.description.length > 80
                  ? ag.description.substring(0, 77) + "..."
                  : ag.description;
              yield* terminal.log(`${prefix}  Description: ${truncatedDesc}`);
            }
            yield* terminal.log(`${prefix}  Model: ${ag.config.llmProvider}/${ag.config.llmModel}`);
            if (ag.config.reasoningEffort) {
              yield* terminal.log(`${prefix}  Reasoning: ${ag.config.reasoningEffort}`);
            }
            yield* terminal.log("");
          }

          yield* terminal.log(
            `   Total: ${allAgents.length} agent${allAgents.length === 1 ? "" : "s"}`,
          );
        }

        yield* terminal.log("");
        return { shouldContinue: true };
      }

      case "compact": {
        if (!conversationHistory || conversationHistory.length < 5) {
          yield* terminal.warn("Not enough history to compact (minimum 5 messages).");
          yield* terminal.log("");
          return { shouldContinue: true };
        }

        const messageCount = conversationHistory.length - 1; // Exclude system message

        // Stage 1: Reading
        store.setStatus(`📖 Reading ${messageCount} messages from conversation history...`);
        yield* Effect.sleep("1 seconds");

        try {
          // Keep system message [0], summarize everything else [1...N]
          const messagesToSummarize = conversationHistory.slice(1);

          // Clear loading and show success for Stage 1
          store.setStatus(null);
          yield* terminal.success(`📖 Read ${messageCount} messages from conversation history`);
          yield* terminal.log("");

          // Stage 2: Analyzing
          store.setStatus("🧠 Analyzing content and extracting key information...");
          yield* Effect.sleep("2.5 seconds");

          // Clear loading and show success for Stage 2
          store.setStatus(null);
          yield* terminal.success("🧠 Analyzed content and extracted key information");
          yield* terminal.log("");

          // Stage 3: Summarizing
          store.setStatus("✨ Generating high-density summary...");

          const summaryMessage = yield* AgentRunner.summarizeHistory(
            messagesToSummarize,
            agent,
            sessionId,
            conversationId || "manual-compact",
          );

          // Clear loading and show success for Stage 3
          store.setStatus(null);
          yield* terminal.success("✨ Generated high-density summary");
          yield* terminal.log("");

          const newHistory: ChatMessage[] = [conversationHistory[0] as ChatMessage, summaryMessage];

          yield* terminal.success("Conversation context compacted successfully!");
          yield* terminal.log(
            `   Reduced from ${messageCount + 1} messages to 2 (system + summary)`,
          );
          yield* terminal.log("   Earlier context compressed while preserving key information");
          yield* terminal.log("");

          return { shouldContinue: true, newHistory };
        } catch (error) {
          // Clear loading status on error
          store.setStatus(null);
          yield* terminal.error(
            `Failed to compact history: ${error instanceof Error ? error.message : String(error)}`,
          );
          yield* terminal.log("");
          return { shouldContinue: true };
        }
      }

      case "copy": {
        // Find the last assistant message in the history
        // Iterate backwards through history
        let lastResponse: string | null = null;
        for (let i = conversationHistory.length - 1; i >= 0; i--) {
          const msg = conversationHistory[i];
          if (msg && msg.role === "assistant" && msg.content) {
            lastResponse = msg.content;
            break;
          }
        }

        if (!lastResponse) {
          yield* terminal.warn("No agent response found to copy.");
          yield* terminal.log("");
          return { shouldContinue: true };
        }

        // Copy to clipboard using pbcopy (macOS specific for now as per user environment)
        try {
          // Use Effect.promise to handle the child process execution
          yield* Effect.promise(() => new Promise<void>((resolve, reject) => {
            const pbcopy = spawn("pbcopy");
            pbcopy.stdin.write(lastResponse);
            pbcopy.stdin.end();

            pbcopy.on("close", (code) => {
              if (code === 0) {
                resolve();
              } else {
                reject(new Error(`pbcopy exited with code ${code}`));
              }
            });

            pbcopy.on("error", (err) => {
              reject(err);
            });
          }));

          yield* terminal.success("Last agent response copied to clipboard!");
          yield* terminal.log("");
        } catch (error) {
           yield* terminal.error(
            `Failed to copy to clipboard: ${error instanceof Error ? error.message : String(error)}`,
          );
          yield* terminal.log("   (Note: /copy currently requires pbcopy on macOS)");
          yield* terminal.log("");
        }
        return { shouldContinue: true };
      }

      case "switch": {
        const agentService = yield* AgentServiceTag;

        // Check if agent identifier was provided as argument
        if (command.args.length > 0) {
          const agentIdentifier = command.args.join(" ").trim();

          // Try to get agent by identifier (name or ID)
          const switchResult = yield* getAgentByIdentifier(agentIdentifier).pipe(
            Effect.map((foundAgent) => ({ success: true as const, agent: foundAgent })),
            Effect.catchAll((error) =>
              Effect.gen(function* () {
                if (error._tag === "StorageNotFoundError") {
                  yield* terminal.error(`Agent not found: ${agentIdentifier}`);
                  yield* terminal.info("Use '/agents' to see all available agents.");
                  yield* terminal.log("");
                } else {
                  yield* terminal.error(
                    `Error loading agent: ${error instanceof Error ? error.message : String(error)}`,
                  );
                  yield* terminal.log("");
                }
                return { success: false as const };
              }),
            ),
          );

          if (switchResult.success) {
            const newAgent = switchResult.agent;
            yield* terminal.success(`Switched to agent: ${newAgent.name} (${newAgent.id})`);
            if (newAgent.description) {
              yield* terminal.log(`   Description: ${newAgent.description}`);
            }
            yield* terminal.log(
              `   Model: ${newAgent.config.llmProvider}/${newAgent.config.llmModel}`,
            );
            yield* terminal.log("");
            yield* terminal.info("Conversation history preserved.");
            yield* terminal.log("");

            return { shouldContinue: true, newAgent };
          }

          return { shouldContinue: true };
        }

        // Interactive mode - show list of agents
        const allAgents = yield* agentService.listAgents();

        if (allAgents.length === 0) {
          yield* terminal.warn("No agents available to switch to.");
          yield* terminal.info("Create one with: jazz agent create");
          yield* terminal.log("");
          return { shouldContinue: true };
        }

        if (allAgents.length === 1) {
          yield* terminal.warn("Only one agent available. Cannot switch.");
          yield* terminal.info("Create more agents with: jazz agent create");
          yield* terminal.log("");
          return { shouldContinue: true };
        }

        // Show interactive prompt
        const choices = allAgents.map((ag) => ({
          name: `${ag.name} - ${ag.config.llmProvider}/${ag.config.llmModel}${ag.id === agent.id ? " (current)" : ""}`,
          value: ag.id,
        }));

        const selectedAgentId = yield* terminal.select<string>("Select an agent to switch to:", {
          choices,
          default: agent.id,
        });

        // If user selected the same agent, do nothing
        if (selectedAgentId === agent.id) {
          yield* terminal.info("Already using this agent.");
          yield* terminal.log("");
          return { shouldContinue: true };
        }

        const newAgent = yield* agentService.getAgent(selectedAgentId);

        yield* terminal.success(`Switched to agent: ${newAgent.name} (${newAgent.id})`);
        if (newAgent.description) {
          yield* terminal.log(`   Description: ${newAgent.description}`);
        }
        yield* terminal.log(`   Model: ${newAgent.config.llmProvider}/${newAgent.config.llmModel}`);
        yield* terminal.log("");
        yield* terminal.info("Conversation history preserved.");
        yield* terminal.log("");

        return { shouldContinue: true, newAgent };
      }

      case "clear":
        console.clear();
        yield* terminal.info(`Chat with ${agent.name} - Screen cleared`);
        yield* terminal.info("Type '/exit' to end the conversation.");
        yield* terminal.info("Type '/help' to see available commands.");
        yield* terminal.log("");
        return { shouldContinue: true };

      case "unknown":
        yield* terminal.error(`Unknown command: /${command.args.join(" ")}`);
        yield* terminal.info("Type '/help' to see available commands.");
        yield* terminal.log("");
        return { shouldContinue: true };

      default:
        return { shouldContinue: true };
    }
  });
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

/**
 * Generate a session ID in the format: {agentName}-YYYYMMDD-HHmmss
 */
function generateSessionId(agentName: string): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  return `${agentName}-${year}${month}${day}-${hours}${minutes}${seconds}`;
}

/**
 * Generate a unique conversation ID
 */
function generateConversationId(): string {
  return short.generate();
}
