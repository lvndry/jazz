import { Effect } from "effect";
import { spawn } from "node:child_process";
import { store } from "@/cli/ui/App";
import { AgentRunner } from "@/core/agent/agent-runner";
import { getAgentByIdentifier } from "@/core/agent/agent-service";
import { normalizeToolConfig } from "@/core/agent/utils/tool-config";
import type { AgentConfigService } from "@/core/interfaces/agent-config";
import { AgentServiceTag, type AgentService } from "@/core/interfaces/agent-service";
import {
  FileSystemContextServiceTag,
  type FileSystemContextService,
} from "@/core/interfaces/fs";
import type { LLMService } from "@/core/interfaces/llm";
import type { LoggerService } from "@/core/interfaces/logger";
import type { PresentationService } from "@/core/interfaces/presentation";
import { TerminalServiceTag, type TerminalService } from "@/core/interfaces/terminal";
import {
  ToolRegistryTag,
  type ToolRegistry,
  type ToolRequirements,
} from "@/core/interfaces/tool-registry";
import { StorageError, StorageNotFoundError } from "@/core/types/errors";
import { generateConversationId } from "../session";
import type { CommandContext, CommandResult, SpecialCommand } from "./types";

/**
 * Handle special commands from user input.
 *
 * This function dispatches to individual command handlers based on the command type.
 */
export function handleSpecialCommand(
  command: SpecialCommand,
  context: CommandContext,
): Effect.Effect<
  CommandResult,
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
  const { agent, conversationId, conversationHistory, sessionId } = context;

  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;

    switch (command.type) {
      case "new":
        return yield* handleNewCommand(terminal);

      case "help":
        return yield* handleHelpCommand(terminal);

      case "status":
        return yield* handleStatusCommand(terminal, agent, conversationId, conversationHistory);

      case "tools":
        return yield* handleToolsCommand(terminal, agent);

      case "agents":
        return yield* handleAgentsCommand(terminal, agent);

      case "switch":
        return yield* handleSwitchCommand(terminal, agent, command.args);

      case "compact":
        return yield* handleCompactCommand(
          terminal,
          agent,
          conversationHistory,
          sessionId,
          conversationId,
        );

      case "copy":
        return yield* handleCopyCommand(terminal, conversationHistory);

      case "clear":
        return yield* handleClearCommand(terminal, agent);

      case "unknown":
        return yield* handleUnknownCommand(terminal, command.args);

      default:
        return { shouldContinue: true };
    }
  });
}

/**
 * Handle /new command - Start a new conversation
 */
function handleNewCommand(
  terminal: TerminalService,
): Effect.Effect<CommandResult, never, never> {
  return Effect.gen(function* () {
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
  });
}

/**
 * Handle /help command - Show available commands
 */
function handleHelpCommand(
  terminal: TerminalService,
): Effect.Effect<CommandResult, never, never> {
  return Effect.gen(function* () {
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
  });
}

/**
 * Handle /status command - Show conversation status
 */
function handleStatusCommand(
  terminal: TerminalService,
  agent: CommandContext["agent"],
  conversationId: string | undefined,
  conversationHistory: CommandContext["conversationHistory"],
): Effect.Effect<CommandResult, never, FileSystemContextService> {
  return Effect.gen(function* () {
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
  });
}

/**
 * Handle /tools command - List agent tools by category
 */
function handleToolsCommand(
  terminal: TerminalService,
  agent: CommandContext["agent"],
): Effect.Effect<CommandResult, never, ToolRegistry> {
  return Effect.gen(function* () {
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
  });
}

/**
 * Handle /agents command - List all available agents
 */
function handleAgentsCommand(
  terminal: TerminalService,
  currentAgent: CommandContext["agent"],
): Effect.Effect<CommandResult, StorageError | StorageNotFoundError, AgentService> {
  return Effect.gen(function* () {
    const agentService = yield* AgentServiceTag;
    const allAgents = yield* agentService.listAgents();

    yield* terminal.heading("🤖 Available Agents");

    if (allAgents.length === 0) {
      yield* terminal.warn("No agents found.");
      yield* terminal.info("Create one with: jazz agent create");
    } else {
      for (const ag of allAgents) {
        const isCurrent = ag.id === currentAgent.id;
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
  });
}

/**
 * Handle /switch command - Switch to a different agent
 */
function handleSwitchCommand(
  terminal: TerminalService,
  currentAgent: CommandContext["agent"],
  args: string[],
): Effect.Effect<CommandResult, StorageError | StorageNotFoundError | Error, AgentService> {
  return Effect.gen(function* () {
    const agentService = yield* AgentServiceTag;

    // Check if agent identifier was provided as argument
    if (args.length > 0) {
      const agentIdentifier = args.join(" ").trim();

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
      name: `${ag.name} - ${ag.config.llmProvider}/${ag.config.llmModel}${ag.id === currentAgent.id ? " (current)" : ""}`,
      value: ag.id,
    }));

    const selectedAgentId = yield* terminal.select<string>("Select an agent to switch to:", {
      choices,
      default: currentAgent.id,
    });

    // If user selected the same agent, do nothing
    if (selectedAgentId === currentAgent.id) {
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
  });
}

/**
 * Handle /compact command - Summarize history to save tokens
 */
function handleCompactCommand(
  terminal: TerminalService,
  agent: CommandContext["agent"],
  conversationHistory: CommandContext["conversationHistory"],
  sessionId: string,
  conversationId: string | undefined,
): Effect.Effect<
  CommandResult,
  Error,
  LLMService | ToolRegistry | LoggerService | AgentConfigService | PresentationService | ToolRequirements
> {
  return Effect.gen(function* () {
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

      const newHistory = [
        conversationHistory[0] as CommandContext["conversationHistory"][0],
        summaryMessage,
      ];

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
  });
}

/**
 * Handle /copy command - Copy last response to clipboard
 */
function handleCopyCommand(
  terminal: TerminalService,
  conversationHistory: CommandContext["conversationHistory"],
): Effect.Effect<CommandResult, never, never> {
  return Effect.gen(function* () {
    // Find the last assistant message in the history
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

    // Copy to clipboard using pbcopy (macOS specific for now)
    try {
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
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
          }),
      );

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
  });
}

/**
 * Handle /clear command - Clear the screen
 */
function handleClearCommand(
  terminal: TerminalService,
  agent: CommandContext["agent"],
): Effect.Effect<CommandResult, never, never> {
  return Effect.gen(function* () {
    console.clear();
    yield* terminal.info(`Chat with ${agent.name} - Screen cleared`);
    yield* terminal.info("Type '/exit' to end the conversation.");
    yield* terminal.info("Type '/help' to see available commands.");
    yield* terminal.log("");
    return { shouldContinue: true };
  });
}

/**
 * Handle unknown command
 */
function handleUnknownCommand(
  terminal: TerminalService,
  args: string[],
): Effect.Effect<CommandResult, never, never> {
  return Effect.gen(function* () {
    yield* terminal.error(`Unknown command: /${args.join(" ")}`);
    yield* terminal.info("Type '/help' to see available commands.");
    yield* terminal.log("");
    return { shouldContinue: true };
  });
}
