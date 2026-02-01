import { spawn } from "node:child_process";
import * as path from "node:path";
import { Effect } from "effect";
import { formatMarkdown } from "@/cli/presentation/markdown-formatter";
import { store } from "@/cli/ui/App";
import { AgentRunner } from "@/core/agent/agent-runner";
import { getAgentByIdentifier } from "@/core/agent/agent-service";
import { normalizeToolConfig } from "@/core/agent/utils/tool-config";
import { DEFAULT_CONTEXT_WINDOW } from "@/core/constants/models";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
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
import { SkillServiceTag, type SkillService } from "@/core/skills/skill-service";
import { StorageError, StorageNotFoundError } from "@/core/types/errors";
import type { ChatMessage } from "@/core/types/message";
import { resolveDisplayConfig } from "@/core/utils/display-config";
import { getModelsDevMetadata } from "@/services/llm/models-dev-client";
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
  | SkillService
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

      case "skills":
        return yield* handleSkillsCommand(terminal);

      case "context":
        return yield* handleContextCommand(terminal, agent, conversationHistory);

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
    yield* terminal.log("   /context         - Show context window usage and token breakdown");
    yield* terminal.log("   /copy            - Copy the last agent response to clipboard");
    yield* terminal.log("   /skills          - List and view available skills");
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

    // User cancelled selection (Escape key)
    if (!selectedAgentId) {
      return { shouldContinue: true };
    }

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

/**
 * Handle /skills command - List and view skills
 */
function handleSkillsCommand(
  terminal: TerminalService,
): Effect.Effect<CommandResult, Error, AgentConfigService | SkillService> {
  return Effect.gen(function* () {
    const skillService = yield* SkillServiceTag;
    const configService = yield* AgentConfigServiceTag;
    const appConfig = yield* configService.appConfig;
    const displayConfig = resolveDisplayConfig(appConfig);
    const skills = yield* skillService.listSkills();

    if (skills.length === 0) {
      yield* terminal.warn("No skills found in ~/.jazz or local folder.");
      yield* terminal.log("");
      return { shouldContinue: true };
    }

    // Sort by name
    const sortedSkills = [...skills].sort((a, b) => a.name.localeCompare(b.name));

    const choices = sortedSkills.map((s) => ({
      name: `${s.name} - ${s.description}`,
      value: s.name,
    }));

    const selectedSkillName = yield* terminal.select<string>("Select a skill to view:", {
      choices,
    });

    // User cancelled selection (Escape key)
    if (!selectedSkillName) {
      return { shouldContinue: true };
    }

    const skillContent = yield* skillService.loadSkill(selectedSkillName);

    yield* terminal.heading(`📜 Skill: ${skillContent.metadata.name}`);
    yield* terminal.log(
      `${path.join(skillContent.metadata.path, "SKILL.md")}`,
    );
    if (skillContent.metadata.description) {
      yield* terminal.log(skillContent.metadata.description);
    }
    yield* terminal.log("");
    const formattedSkill =
      displayConfig.mode === "markdown"
        ? formatMarkdown(skillContent.core)
        : skillContent.core;
    yield* terminal.log(formattedSkill);
    yield* terminal.log("");

    return { shouldContinue: true };
  });
}

// ============================================================================
// Context Command Utilities
// ============================================================================

/** Symbols for context visualization */
const CONTEXT_SYMBOLS = {
  used: "⛁",
  free: "⛶",
  buffer: "⛝",
} as const;

/** Grid dimensions for visualization (10x10 = 100 cells) */
const GRID_SIZE = 10;
const TOTAL_CELLS = GRID_SIZE * GRID_SIZE;

/** Buffer percentage reserved for autocompact (16.5% like Claude Code) */
const AUTOCOMPACT_BUFFER_PERCENT = 0.165;

/**
 * Get context window size for a specific model from models.dev
 */
function getModelContextWindowEffect(modelId: string): Effect.Effect<number, never, never> {
  return Effect.tryPromise({
    try: async () => {
      const meta = await getModelsDevMetadata(modelId);
      return meta?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    },
    catch: () => new Error("Failed to fetch model metadata"),
  }).pipe(Effect.catchAll(() => Effect.succeed(DEFAULT_CONTEXT_WINDOW)));
}

/**
 * Estimate tokens for a message
 */
function estimateMessageTokens(message: ChatMessage): number {
  let contentTokens = 0;
  if (message.content) {
    contentTokens = Math.ceil(message.content.length / 4);
  }

  let toolTokens = 0;
  if (message.tool_calls) {
    toolTokens = Math.ceil(JSON.stringify(message.tool_calls).length / 4);
  } else if (message.role === "tool" && message.tool_call_id) {
    toolTokens = 10;
  }

  return contentTokens + toolTokens + 4;
}

/**
 * Format token count for display (e.g., 18000 -> "18k", 150000 -> "150k")
 */
function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  }
  return tokens.toString();
}

/**
 * Calculate context usage breakdown
 */
interface ContextUsageBreakdown {
  systemPromptTokens: number;
  toolsTokens: number;
  skillsTokens: number;
  messagesTokens: number;
  totalUsed: number;
  freeSpace: number;
  autocompactBuffer: number;
  contextWindow: number;
}

function calculateContextUsage(
  conversationHistory: ChatMessage[],
  contextWindow: number,
): ContextUsageBreakdown {
  // Calculate autocompact buffer (reserved space)
  const autocompactBuffer = Math.floor(contextWindow * AUTOCOMPACT_BUFFER_PERCENT);
  const effectiveWindow = contextWindow - autocompactBuffer;

  // Separate system message from other messages
  const systemMessage = conversationHistory.find((m) => m.role === "system");
  const otherMessages = conversationHistory.filter((m) => m.role !== "system");

  // Estimate system prompt tokens
  const systemPromptTokens = systemMessage ? estimateMessageTokens(systemMessage) : 0;

  // Tool tokens are estimated from tool calls in messages
  let toolsTokens = 0;
  let messagesTokens = 0;

  for (const msg of otherMessages) {
    const tokens = estimateMessageTokens(msg);
    if (msg.role === "tool" || (msg.role === "assistant" && msg.tool_calls)) {
      toolsTokens += tokens;
    } else {
      messagesTokens += tokens;
    }
  }

  // Skills tokens are part of system prompt but we can't easily separate them
  // For now, we'll estimate them as 0 (they're included in systemPromptTokens)
  const skillsTokens = 0;

  const totalUsed = systemPromptTokens + toolsTokens + skillsTokens + messagesTokens;
  const freeSpace = Math.max(0, effectiveWindow - totalUsed);

  return {
    systemPromptTokens,
    toolsTokens,
    skillsTokens,
    messagesTokens,
    totalUsed,
    freeSpace,
    autocompactBuffer,
    contextWindow,
  };
}

/**
 * Generate the visual context grid
 */
function generateContextGrid(usage: ContextUsageBreakdown): string[] {
  const { totalUsed, freeSpace, autocompactBuffer, contextWindow } = usage;

  // Calculate cell allocations
  const usedCells = Math.round((totalUsed / contextWindow) * TOTAL_CELLS);
  const freeCells = Math.round((freeSpace / contextWindow) * TOTAL_CELLS);
  const bufferCells = Math.round((autocompactBuffer / contextWindow) * TOTAL_CELLS);

  // Ensure we fill exactly 100 cells
  const adjusted = usedCells + freeCells + bufferCells;
  let adjustedFreeCells = freeCells;
  if (adjusted !== TOTAL_CELLS) {
    adjustedFreeCells = TOTAL_CELLS - usedCells - bufferCells;
  }

  // Build the grid string
  const cells: string[] = [];
  for (let i = 0; i < usedCells; i++) cells.push(CONTEXT_SYMBOLS.used);
  for (let i = 0; i < Math.max(0, adjustedFreeCells); i++) cells.push(CONTEXT_SYMBOLS.free);
  for (let i = 0; i < bufferCells; i++) cells.push(CONTEXT_SYMBOLS.buffer);

  // Pad or trim to exactly 100 cells
  while (cells.length < TOTAL_CELLS) cells.push(CONTEXT_SYMBOLS.free);
  cells.length = TOTAL_CELLS;

  // Format into rows
  const rows: string[] = [];
  for (let row = 0; row < GRID_SIZE; row++) {
    const rowCells = cells.slice(row * GRID_SIZE, (row + 1) * GRID_SIZE);
    rows.push(rowCells.join(" "));
  }

  return rows;
}

/**
 * Handle /context command - Show context window usage
 */
function handleContextCommand(
  terminal: TerminalService,
  agent: CommandContext["agent"],
  conversationHistory: CommandContext["conversationHistory"],
): Effect.Effect<CommandResult, never, ToolRegistry> {
  return Effect.gen(function* () {
    const toolRegistry = yield* ToolRegistryTag;

    // Get model information
    const provider = agent.config.llmProvider;
    const modelId = agent.config.llmModel;
    const contextWindow = yield* getModelContextWindowEffect(modelId);

    // Get tool definitions for more accurate tool token estimation
    const toolDefinitions = yield* toolRegistry.getToolDefinitions();
    const toolDefinitionsJson = JSON.stringify(toolDefinitions);
    const toolDefinitionTokens = Math.ceil(toolDefinitionsJson.length / 4);

    // Calculate usage breakdown
    const usage = calculateContextUsage(conversationHistory, contextWindow);

    // Add tool definition tokens (these are sent with every request)
    const adjustedUsage: ContextUsageBreakdown = {
      ...usage,
      toolsTokens: usage.toolsTokens + toolDefinitionTokens,
      totalUsed: usage.totalUsed + toolDefinitionTokens,
      freeSpace: Math.max(0, usage.freeSpace - toolDefinitionTokens),
    };

    // Calculate percentages
    const usagePercent = Math.round((adjustedUsage.totalUsed / contextWindow) * 100);
    const systemPercent = ((adjustedUsage.systemPromptTokens / contextWindow) * 100).toFixed(1);
    const toolsPercent = ((adjustedUsage.toolsTokens / contextWindow) * 100).toFixed(1);
    const skillsPercent = ((adjustedUsage.skillsTokens / contextWindow) * 100).toFixed(1);
    const messagesPercent = ((adjustedUsage.messagesTokens / contextWindow) * 100).toFixed(1);
    const freePercent = ((adjustedUsage.freeSpace / contextWindow) * 100).toFixed(1);
    const bufferPercent = ((adjustedUsage.autocompactBuffer / contextWindow) * 100).toFixed(1);

    // Generate visual grid
    const gridRows = generateContextGrid(adjustedUsage);

    // Display header
    yield* terminal.heading("Context Usage");

    // Display model info and total usage on first row
    const modelDisplay = `${provider}/${modelId}`;
    const usageDisplay = `${formatTokenCount(adjustedUsage.totalUsed)}/${formatTokenCount(contextWindow)} tokens (${usagePercent}%)`;

    yield* terminal.log(`   ${gridRows[0]}   ${modelDisplay} · ${usageDisplay}`);
    yield* terminal.log(`   ${gridRows[1]}`);
    yield* terminal.log(`   ${gridRows[2]}   Estimated usage by category`);
    yield* terminal.log(
      `   ${gridRows[3]}   ${CONTEXT_SYMBOLS.used} System prompt: ${formatTokenCount(adjustedUsage.systemPromptTokens)} tokens (${systemPercent}%)`,
    );
    yield* terminal.log(
      `   ${gridRows[4]}   ${CONTEXT_SYMBOLS.used} System tools: ${formatTokenCount(adjustedUsage.toolsTokens)} tokens (${toolsPercent}%)`,
    );
    yield* terminal.log(
      `   ${gridRows[5]}   ${CONTEXT_SYMBOLS.used} Skills: ${formatTokenCount(adjustedUsage.skillsTokens)} tokens (${skillsPercent}%)`,
    );
    yield* terminal.log(
      `   ${gridRows[6]}   ${CONTEXT_SYMBOLS.used} Messages: ${formatTokenCount(adjustedUsage.messagesTokens)} tokens (${messagesPercent}%)`,
    );
    yield* terminal.log(
      `   ${gridRows[7]}   ${CONTEXT_SYMBOLS.free} Free space: ${formatTokenCount(adjustedUsage.freeSpace)} (${freePercent}%)`,
    );
    yield* terminal.log(
      `   ${gridRows[8]}   ${CONTEXT_SYMBOLS.buffer} Autocompact buffer: ${formatTokenCount(adjustedUsage.autocompactBuffer)} tokens (${bufferPercent}%)`,
    );
    yield* terminal.log(`   ${gridRows[9]}`);
    yield* terminal.log("");

    return { shouldContinue: true };
  });
}
