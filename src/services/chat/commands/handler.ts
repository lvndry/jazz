import { spawn } from "node:child_process";
import { Effect } from "effect";
import * as fmt from "@/cli/utils/list-format";
import { AgentRunner } from "@/core/agent/agent-runner";
import { getAgentByIdentifier } from "@/core/agent/agent-service";
import { WEB_SEARCH_PROVIDERS } from "@/core/agent/tools/web-search-tools";
import { normalizeToolConfig } from "@/core/agent/utils/tool-config";
import { STATIC_PROVIDER_MODELS, DEFAULT_CONTEXT_WINDOW } from "@/core/constants/models";
import type { ProviderName } from "@/core/constants/models";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
import { AgentServiceTag, type AgentService } from "@/core/interfaces/agent-service";
import { FileSystemContextServiceTag, type FileSystemContextService } from "@/core/interfaces/fs";
import { LLMServiceTag, type LLMService } from "@/core/interfaces/llm";
import type { LoggerService } from "@/core/interfaces/logger";
import {
  MCPServerManagerTag,
  isStdioConfig,
  isHttpConfig,
  type MCPServerManager,
} from "@/core/interfaces/mcp-server";
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
import type { AutoApprovePolicy } from "@/core/types/tools";
import { sortAgents } from "@/core/utils/agent-sort";
import { describeCronSchedule } from "@/core/utils/cron-utils";
import { getModelsDevMetadata } from "@/core/utils/models-dev-client";
import { WorkflowServiceTag, type WorkflowService } from "@/core/workflows/workflow-service";
import type { WorkflowMetadata } from "@/core/workflows/workflow-service";
import { groupWorkflows } from "@/core/workflows/workflow-utils";
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
  | WorkflowService
  | MCPServerManager
> {
  const { agent, conversationId, conversationHistory, sessionId } = context;

  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;

    switch (command.type) {
      case "new":
        return yield* handleNewCommand(terminal);

      case "help":
        return yield* handleHelpCommand(terminal);

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

      case "model":
        return yield* handleModelCommand(terminal, agent, command.args);

      case "config":
        return yield* handleConfigCommand(terminal, agent, command.args);

      case "skills":
        return yield* handleSkillsCommand(terminal);

      case "context":
        return yield* handleContextCommand(terminal, agent, conversationHistory);

      case "cost":
        return yield* handleCostCommand(terminal, agent, context.sessionUsage);

      case "workflows":
        return yield* handleWorkflowsCommand(terminal);

      case "stats":
        return yield* handleStatsCommand(terminal, agent, context);

      case "mcp":
        return yield* handleMcpCommand(terminal);

      case "mode":
        return yield* handleModeCommand(
          terminal,
          command.args,
          context.autoApprovePolicy,
          context.autoApprovedCommands,
          context.persistedAutoApprovedCommands,
          context.autoApprovedTools,
        );

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
function handleNewCommand(terminal: TerminalService): Effect.Effect<CommandResult, never, never> {
  return Effect.gen(function* () {
    yield* terminal.info("Starting new conversation...");
    yield* terminal.log(fmt.item("Conversation context cleared"));
    yield* terminal.log(fmt.item("Fresh start with the agent"));
    yield* terminal.log(fmt.blank());
    yield* terminal.log(fmt.blank());
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
function handleHelpCommand(terminal: TerminalService): Effect.Effect<CommandResult, never, never> {
  return Effect.gen(function* () {
    yield* terminal.log(fmt.heading("Available Commands"));
    yield* terminal.log(fmt.commandRow("/new", "Start a new conversation (clear context)"));
    yield* terminal.log(fmt.commandRow("/tools", "List all agent tools by category"));
    yield* terminal.log(fmt.commandRow("/agents", "List all available agents"));
    yield* terminal.log(fmt.commandRow("/switch [agent]", "Switch to a different agent"));
    yield* terminal.log(fmt.commandRow("/clear", "Clear the screen"));
    yield* terminal.log(fmt.commandRow("/compact", "Summarize history to save tokens"));
    yield* terminal.log(fmt.commandRow("/context", "Show context window usage"));
    yield* terminal.log(fmt.commandRow("/cost", "Show token usage and estimated cost"));
    yield* terminal.log(fmt.commandRow("/copy", "Copy last agent response to clipboard"));
    yield* terminal.log(fmt.commandRow("/model", "Show or change model and reasoning"));
    yield* terminal.log(fmt.commandRow("/config", "Show or modify agent configuration"));
    yield* terminal.log(fmt.commandRow("/skills", "List and view available skills"));
    yield* terminal.log(fmt.commandRow("/workflows", "List or create workflows"));
    yield* terminal.log(fmt.commandRow("/stats", "Show session statistics"));
    yield* terminal.log(fmt.commandRow("/mcp", "Show MCP server status"));
    yield* terminal.log(fmt.commandRow("/mode", "Switch approval modes"));
    yield* terminal.log(fmt.commandRow("/help", "Show this help message"));
    yield* terminal.log(fmt.commandRow("/exit", "Exit the chat"));
    yield* terminal.log(fmt.blank());
    return { shouldContinue: true };
  });
}

/**
 * Handle /tools command - List agent tools by category
 */
function handleToolsCommand(
  terminal: TerminalService,
  agent: CommandContext["agent"],
): Effect.Effect<CommandResult, never, ToolRegistry | AgentConfigService | LLMService> {
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

    // Resolve web_search provider info for annotation
    const webSearchProvider = yield* resolveWebSearchProviderLabel(agent);

    yield* terminal.log(fmt.heading(`Tools Available to ${agent.name}`));

    if (Object.keys(filteredToolsByCategory).length === 0) {
      yield* terminal.warn("This agent has no tools configured.");
    } else {
      const sortedCategories = Object.keys(filteredToolsByCategory).sort();

      for (const category of sortedCategories) {
        const tools = filteredToolsByCategory[category];
        if (tools && tools.length > 0) {
          yield* terminal.log(fmt.section(category, tools.length, "tool"));
          for (const tool of tools) {
            if (tool === "web_search" && webSearchProvider) {
              yield* terminal.log(fmt.itemWithDesc(tool, webSearchProvider));
            } else {
              yield* terminal.log(fmt.item(tool));
            }
          }
          yield* terminal.log(fmt.blank());
        }
      }

      const totalTools = Object.values(filteredToolsByCategory).reduce(
        (sum, tools) => sum + (tools?.length || 0),
        0,
      );

      yield* terminal.log(
        fmt.footer(`Total: ${totalTools} tools across ${sortedCategories.length} categories`),
      );
    }

    yield* terminal.log(fmt.blank());
    return { shouldContinue: true };
  });
}

/**
 * Resolve a human-readable label for the active web_search provider.
 *
 * Returns e.g. "via Brave", "via OpenAI (native)", or null if web_search
 * is not in use / no provider could be determined.
 */
function resolveWebSearchProviderLabel(
  agent: CommandContext["agent"],
): Effect.Effect<string | null, never, AgentConfigService | LLMService> {
  return Effect.gen(function* () {
    const configService = yield* AgentConfigServiceTag;
    const appConfig = yield* configService.appConfig;

    // 1. Check for an explicitly configured external provider
    const externalProvider = appConfig.web_search?.provider;
    if (externalProvider) {
      const display =
        WEB_SEARCH_PROVIDERS.find((p) => p.value === externalProvider)?.name ?? externalProvider;
      return `via ${display}`;
    }

    // 2. Check if the agent's LLM provider supports native web search
    const llmService = yield* LLMServiceTag;
    const supportsNative = yield* llmService.supportsNativeWebSearch(agent.config.llmProvider);
    if (supportsNative) {
      const providerName =
        agent.config.llmProvider.charAt(0).toUpperCase() + agent.config.llmProvider.slice(1);
      return `via ${providerName} (native)`;
    }

    // 3. No provider available
    return "no provider configured";
  }).pipe(Effect.catchAll(() => Effect.succeed(null)));
}

/**
 * Handle /agents command - List all available agents
 */
function handleAgentsCommand(
  terminal: TerminalService,
  currentAgent: CommandContext["agent"],
): Effect.Effect<
  CommandResult,
  StorageError | StorageNotFoundError,
  AgentService | AgentConfigService
> {
  return Effect.gen(function* () {
    const agentService = yield* AgentServiceTag;
    const configService = yield* AgentConfigServiceTag;
    const allAgentsUnsorted = yield* agentService.listAgents();

    yield* terminal.log(fmt.heading("Available Agents"));

    if (allAgentsUnsorted.length === 0) {
      yield* terminal.warn("No agents found.");
      yield* terminal.info("Create one with: jazz agent create");
    } else {
      const lastUsedAgentId = yield* configService.get("wizard.lastUsedAgentId").pipe(
        Effect.map((value) => (typeof value === "string" ? value : null)),
        Effect.catchAll(() => Effect.succeed(null)),
      );
      const allAgents = sortAgents(allAgentsUnsorted, lastUsedAgentId);

      for (const ag of allAgents) {
        const isCurrent = ag.id === currentAgent.id;

        if (isCurrent) {
          yield* terminal.log(fmt.labeledItem(ag.name, "(current)"));
        } else {
          yield* terminal.log(fmt.labeledItemDim(ag.name));
        }
        yield* terminal.log(fmt.keyValue("ID", ag.id));
        if (ag.description) {
          const truncatedDesc =
            ag.description.length > 80 ? ag.description.substring(0, 77) + "..." : ag.description;
          yield* terminal.log(fmt.keyValue("Description", truncatedDesc));
        }
        yield* terminal.log(
          fmt.keyValue("Model", `${ag.config.llmProvider}/${ag.config.llmModel}`),
        );
        if (ag.config.reasoningEffort) {
          yield* terminal.log(fmt.keyValue("Reasoning", ag.config.reasoningEffort));
        }
        yield* terminal.log(fmt.blank());
      }

      yield* terminal.log(
        fmt.footer(`Total: ${allAgents.length} agent${allAgents.length === 1 ? "" : "s"}`),
      );
    }

    yield* terminal.log(fmt.blank());
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
): Effect.Effect<
  CommandResult,
  StorageError | StorageNotFoundError | Error,
  AgentService | AgentConfigService
> {
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
        yield* terminal.success(
          `Switched to ${newAgent.name} (${newAgent.config.llmProvider}/${newAgent.config.llmModel})`,
        );
        yield* terminal.log("");
        return { shouldContinue: true, newAgent };
      }

      return { shouldContinue: true };
    }

    // Interactive mode - show list of agents
    const allAgentsUnsorted = yield* agentService.listAgents();

    if (allAgentsUnsorted.length === 0) {
      yield* terminal.warn("No agents available to switch to.");
      yield* terminal.info("Create one with: jazz agent create");
      yield* terminal.log("");
      return { shouldContinue: true };
    }

    if (allAgentsUnsorted.length === 1) {
      yield* terminal.warn("Only one agent available. Cannot switch.");
      yield* terminal.info("Create more agents with: jazz agent create");
      yield* terminal.log("");
      return { shouldContinue: true };
    }

    // Sort with last-used agent first, then alphabetically
    const configService = yield* AgentConfigServiceTag;
    const lastUsedAgentId = yield* configService.get("wizard.lastUsedAgentId").pipe(
      Effect.map((value) => (typeof value === "string" ? value : null)),
      Effect.catchAll(() => Effect.succeed(null)),
    );
    const allAgents = sortAgents(allAgentsUnsorted, lastUsedAgentId);

    // Show interactive prompt with history preservation note
    yield* terminal.info("History will be preserved after switching.");
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

    yield* terminal.success(
      `Switched to ${newAgent.name} (${newAgent.config.llmProvider}/${newAgent.config.llmModel})`,
    );
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
  | LLMService
  | ToolRegistry
  | LoggerService
  | AgentConfigService
  | PresentationService
  | ToolRequirements
> {
  return Effect.gen(function* () {
    if (!conversationHistory || conversationHistory.length < 5) {
      yield* terminal.warn("Not enough history to compact (minimum 5 messages).");
      yield* terminal.log("");
      return { shouldContinue: true };
    }

    const messageCount = conversationHistory.length - 1; // Exclude system message

    // Stage 1: Reading
    yield* terminal.info(`📖 Reading ${messageCount} messages from conversation history...`);

    try {
      // Keep system message [0], summarize everything else [1...N]
      const messagesToSummarize = conversationHistory.slice(1);

      // Show success for Stage 1
      yield* terminal.success(`📖 Read ${messageCount} messages from conversation history`);
      yield* terminal.log("");

      // Stage 2: Analyzing
      yield* terminal.info("Analyzing content and extracting key information...");

      // Show success for Stage 2
      yield* terminal.success("Analyzed content and extracted key information");
      yield* terminal.log("");

      // Stage 3: Summarizing
      yield* terminal.info("✨ Generating high-density summary...");

      const summaryMessage = yield* AgentRunner.summarizeHistory(
        messagesToSummarize,
        agent,
        sessionId,
        conversationId || "manual-compact",
      );

      // Show success for Stage 3
      yield* terminal.success("✨ Generated high-density summary");
      yield* terminal.log("");

      const newHistory = [
        conversationHistory[0] as CommandContext["conversationHistory"][0],
        summaryMessage,
      ];

      yield* terminal.success("Conversation context compacted successfully!");
      yield* terminal.log(`   Reduced from ${messageCount + 1} messages to 2 (system + summary)`);
      yield* terminal.log("   Earlier context compressed while preserving key information");
      yield* terminal.log("");

      return { shouldContinue: true, newHistory };
    } catch (error) {
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
    yield* Effect.tryPromise({
      try: () =>
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
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.flatMap(() =>
        Effect.all([
          terminal.success("Last agent response copied to clipboard!"),
          terminal.log(""),
        ]),
      ),
      Effect.catchAll((error) =>
        Effect.all([
          terminal.error(`Failed to copy to clipboard: ${error.message}`),
          terminal.log("   (Note: /copy currently requires pbcopy on macOS)"),
          terminal.log(""),
        ]),
      ),
    );
    return { shouldContinue: true };
  });
}

/**
 * Handle /model command - Show or change model and reasoning effort
 */
function handleModelCommand(
  terminal: TerminalService,
  agent: CommandContext["agent"],
  args: string[],
): Effect.Effect<CommandResult, StorageError | StorageNotFoundError | Error, AgentService> {
  return Effect.gen(function* () {
    const agentService = yield* AgentServiceTag;

    // No args: show current model info
    if (args.length === 0) {
      yield* terminal.log(fmt.heading("Current Model"));
      yield* terminal.log(fmt.keyValueCompact("Provider", agent.config.llmProvider));
      yield* terminal.log(fmt.keyValueCompact("Model", agent.config.llmModel));
      yield* terminal.log(
        fmt.keyValueCompact("Reasoning", agent.config.reasoningEffort ?? "default"),
      );
      yield* terminal.log(fmt.blank());
      yield* terminal.info("Usage: /model <provider>/<model> or /model reasoning <level>");
      yield* terminal.log(fmt.blank());
      return { shouldContinue: true };
    }

    // Handle "reasoning" subcommand
    if (args[0] === "reasoning") {
      const level = args[1];
      const validLevels = ["low", "medium", "high", "disable"] as const;
      if (!level || !validLevels.includes(level as (typeof validLevels)[number])) {
        yield* terminal.error(`Invalid reasoning level. Use: ${validLevels.join(", ")}`);
        yield* terminal.log("");
        return { shouldContinue: true };
      }

      const updatedConfig = {
        ...agent.config,
        reasoningEffort: level as "low" | "medium" | "high" | "disable",
      };
      const newAgent = yield* agentService.updateAgent(agent.id, { config: updatedConfig });
      yield* terminal.success(`Reasoning effort set to: ${level}`);
      yield* terminal.log("");
      return { shouldContinue: true, newAgent };
    }

    // Handle provider/model argument
    const modelArg = args.join(" ");
    const slashIndex = modelArg.indexOf("/");
    if (slashIndex === -1) {
      yield* terminal.error("Format: /model <provider>/<model>");
      yield* terminal.info("Example: /model openai/gpt-4o");
      yield* terminal.log("");
      return { shouldContinue: true };
    }

    const providerName = modelArg.substring(0, slashIndex) as ProviderName;
    const modelId = modelArg.substring(slashIndex + 1);

    // Validate provider exists
    if (!(providerName in STATIC_PROVIDER_MODELS)) {
      yield* terminal.error(`Unknown provider: ${providerName}`);
      yield* terminal.info(`Available: ${Object.keys(STATIC_PROVIDER_MODELS).join(", ")}`);
      yield* terminal.log("");
      return { shouldContinue: true };
    }

    const updatedConfig = {
      ...agent.config,
      llmProvider: providerName,
      llmModel: modelId,
    };
    const newAgent = yield* agentService.updateAgent(agent.id, { config: updatedConfig });
    yield* terminal.success(`Model switched to: ${providerName}/${modelId}`);
    yield* terminal.log("");
    return { shouldContinue: true, newAgent };
  });
}

/**
 * Handle /config command - Show or modify agent configuration
 */
function handleConfigCommand(
  terminal: TerminalService,
  agent: CommandContext["agent"],
  args: string[],
): Effect.Effect<
  CommandResult,
  StorageError | StorageNotFoundError | Error,
  AgentService | ToolRegistry
> {
  return Effect.gen(function* () {
    const agentService = yield* AgentServiceTag;

    // "tools" subcommand: show and toggle tools
    if (args[0] === "tools") {
      const toolRegistry = yield* ToolRegistryTag;
      const allToolsByCategory = yield* toolRegistry.listToolsByCategory();
      const allToolNames = Object.values(allToolsByCategory).flat();

      const agentToolNames = normalizeToolConfig(agent.config.tools, { agentId: agent.id });
      const agentToolSet = new Set(agentToolNames);

      const choices = allToolNames.map((tool) => ({
        name: tool,
        value: tool,
      }));

      const selected = yield* terminal.checkbox<string>("Select tools to enable:", {
        choices,
        default: agentToolNames,
      });

      const newTools = [...selected];

      // Report changes
      const added = newTools.filter((t) => !agentToolSet.has(t));
      const removed = agentToolNames.filter((t) => !newTools.includes(t));
      for (const tool of added) {
        yield* terminal.success(`Enabled tool: ${tool}`);
      }
      for (const tool of removed) {
        yield* terminal.success(`Disabled tool: ${tool}`);
      }
      if (added.length === 0 && removed.length === 0) {
        yield* terminal.info("No changes made.");
        return { shouldContinue: true };
      }

      const updatedConfig = { ...agent.config, tools: newTools };
      const newAgent = yield* agentService.updateAgent(agent.id, { config: updatedConfig });
      yield* terminal.log("");
      return { shouldContinue: true, newAgent };
    }

    // No args: show full config
    yield* terminal.log(fmt.heading("Agent Configuration"));
    yield* terminal.log(fmt.keyValueCompact("Name", agent.name));
    if (agent.description) {
      yield* terminal.log(fmt.keyValueCompact("Description", agent.description));
    }
    yield* terminal.log(fmt.keyValueCompact("Type", agent.config.agentType));
    yield* terminal.log(
      fmt.keyValueCompact("Model", `${agent.config.llmProvider}/${agent.config.llmModel}`),
    );
    yield* terminal.log(
      fmt.keyValueCompact("Reasoning", agent.config.reasoningEffort ?? "default"),
    );

    const agentToolNames = normalizeToolConfig(agent.config.tools, { agentId: agent.id });
    yield* terminal.log(fmt.keyValueCompact("Tools", `${agentToolNames.length} enabled`));
    if (agentToolNames.length > 0) {
      for (const tool of agentToolNames.slice(0, 10)) {
        yield* terminal.log(fmt.item(tool));
      }
      if (agentToolNames.length > 10) {
        yield* terminal.log(fmt.overflow(agentToolNames.length - 10));
      }
    }

    yield* terminal.log(fmt.blank());
    yield* terminal.info("Subcommands: /config tools");
    yield* terminal.log(fmt.blank());
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
    // Use terminal.clear() which both clears the screen and resets the
    // Ink output island state (staticEntries + liveEntries).
    yield* terminal.clear();
    yield* terminal.info(`Chat with ${agent.name} - Screen cleared`);
    yield* terminal.info("Type '/help' to see available commands.");
    yield* terminal.info("Type '/exit' to end the conversation.");
    yield* terminal.log("");
    return { shouldContinue: true };
  });
}

/**
 * Handle /workflows command - List available workflows
 */
function handleWorkflowsCommand(
  terminal: TerminalService,
): Effect.Effect<CommandResult, Error, WorkflowService> {
  return Effect.gen(function* () {
    const workflowService = yield* WorkflowServiceTag;

    yield* terminal.log(fmt.heading("Available Workflows"));

    const workflows = yield* workflowService.listWorkflows();

    if (workflows.length === 0) {
      yield* terminal.info("No workflows found.");
      yield* terminal.log(fmt.blank());
      yield* terminal.info("Create a workflow by adding a WORKFLOW.md file to:");
      yield* terminal.log(fmt.item("./workflows/<name>/WORKFLOW.md (local)"));
      yield* terminal.log(fmt.item("~/.jazz/workflows/<name>/WORKFLOW.md (global)"));
      yield* terminal.info("Or type /workflows create and the agent will guide you.");
      yield* terminal.log(fmt.blank());
      return { shouldContinue: true };
    }

    const { local, global, builtin } = groupWorkflows(workflows);

    if (local.length > 0) {
      yield* terminal.log(fmt.section("Local", local.length, "workflow"));
      for (const w of local) {
        yield* terminal.log(fmt.itemWithDesc(w.name, formatWorkflowDesc(w)));
      }
      yield* terminal.log(fmt.blank());
    }

    if (global.length > 0) {
      yield* terminal.log(fmt.section("Global", global.length, "workflow"));
      for (const w of global) {
        yield* terminal.log(fmt.itemWithDesc(w.name, formatWorkflowDesc(w)));
      }
      yield* terminal.log(fmt.blank());
    }

    if (builtin.length > 0) {
      yield* terminal.log(fmt.section("Built-in", builtin.length, "workflow"));
      for (const w of builtin) {
        yield* terminal.log(fmt.itemWithDesc(w.name, formatWorkflowDesc(w)));
      }
      yield* terminal.log(fmt.blank());
    }

    yield* terminal.log(fmt.footer(`Total: ${workflows.length} workflow(s)`));
    yield* terminal.log(fmt.blank());
    return { shouldContinue: true };
  });
}

/**
 * Build a description string for a workflow that includes the cron schedule
 * and assigned agent when present.
 *
 * Example outputs:
 *   "Daily email digest"
 *   "Daily email digest (every day at 9:00 AM)"
 *   "Daily email digest (every day at 9:00 AM, agent: email-bot)"
 */
function formatWorkflowDesc(w: WorkflowMetadata): string {
  const parts: string[] = [w.description];

  const scheduleDesc = w.schedule ? describeCronSchedule(w.schedule) : null;
  if (w.schedule) {
    parts.push(scheduleDesc ? `(${scheduleDesc})` : `[${w.schedule}]`);
  }
  if (w.agent) {
    parts.push(`(agent: ${w.agent})`);
  }

  return parts.join(" ");
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
): Effect.Effect<CommandResult, Error, SkillService> {
  return Effect.gen(function* () {
    const skillService = yield* SkillServiceTag;
    const { builtin, global, agents, local } = yield* skillService.listSkillsBySource();

    const totalCount = builtin.length + global.length + agents.length + local.length;

    if (totalCount === 0) {
      yield* terminal.warn("No skills found.");
      yield* terminal.log(fmt.blank());
      yield* terminal.info("Create a skill by adding a SKILL.md file to:");
      yield* terminal.log(fmt.item("./skills/<name>/SKILL.md (local)"));
      yield* terminal.log(fmt.item("~/.jazz/skills/<name>/SKILL.md (global)"));
      yield* terminal.log(fmt.item("~/.agents/skills/<name>/SKILL.md (shared agents)"));
      yield* terminal.log(fmt.blank());
      return { shouldContinue: true };
    }

    yield* terminal.log(fmt.heading("Available Skills"));

    let sourcesCount = 0;

    if (builtin.length > 0) {
      sourcesCount++;
      const sorted = [...builtin].sort((a, b) => a.name.localeCompare(b.name));
      yield* terminal.log(fmt.section("Built-in", builtin.length, "skill"));
      for (const s of sorted) {
        yield* terminal.log(fmt.itemWithDesc(s.name, s.description));
      }
      yield* terminal.log(fmt.blank());
    }

    if (global.length > 0) {
      sourcesCount++;
      const sorted = [...global].sort((a, b) => a.name.localeCompare(b.name));
      yield* terminal.log(fmt.section("Global", global.length, "skill"));
      for (const s of sorted) {
        yield* terminal.log(fmt.itemWithDesc(s.name, s.description));
      }
      yield* terminal.log(fmt.blank());
    }

    if (agents.length > 0) {
      sourcesCount++;
      const sorted = [...agents].sort((a, b) => a.name.localeCompare(b.name));
      yield* terminal.log(fmt.section("Agents", agents.length, "skill"));
      for (const s of sorted) {
        yield* terminal.log(fmt.itemWithDesc(s.name, s.description));
      }
      yield* terminal.log(fmt.blank());
    }

    if (local.length > 0) {
      sourcesCount++;
      const sorted = [...local].sort((a, b) => a.name.localeCompare(b.name));
      yield* terminal.log(fmt.section("Local", local.length, "skill"));
      for (const s of sorted) {
        yield* terminal.log(fmt.itemWithDesc(s.name, s.description));
      }
      yield* terminal.log(fmt.blank());
    }

    yield* terminal.log(
      fmt.footer(
        `Total: ${totalCount} ${totalCount === 1 ? "skill" : "skills"} across ${sourcesCount} ${sourcesCount === 1 ? "source" : "sources"}`,
      ),
    );
    yield* terminal.log(fmt.blank());

    return { shouldContinue: true };
  });
}

/**
 * Handle /stats command - Show session statistics and usage summary
 */
function handleStatsCommand(
  terminal: TerminalService,
  agent: CommandContext["agent"],
  context: CommandContext,
): Effect.Effect<CommandResult, never, FileSystemContextService> {
  return Effect.gen(function* () {
    yield* terminal.log(fmt.heading("Session Statistics"));

    // Session duration
    const now = new Date();
    const elapsed = now.getTime() - context.sessionStartedAt.getTime();
    const seconds = Math.floor(elapsed / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const durationParts: string[] = [];
    if (hours > 0) durationParts.push(`${hours}h`);
    if (minutes % 60 > 0 || hours > 0) durationParts.push(`${minutes % 60}m`);
    durationParts.push(`${seconds % 60}s`);
    const duration = durationParts.join(" ");

    yield* terminal.log(fmt.keyValueCompact("Agent", `${agent.name} (${agent.id})`));
    yield* terminal.log(
      fmt.keyValueCompact("Model", `${agent.config.llmProvider}/${agent.config.llmModel}`),
    );
    yield* terminal.log(
      fmt.keyValueCompact("Reasoning", agent.config.reasoningEffort ?? "default"),
    );
    const totalTools = agent.config.tools?.length ?? 0;
    yield* terminal.log(fmt.keyValueCompact("Tools", `${totalTools} available`));

    const fileSystemContext = yield* FileSystemContextServiceTag;
    const workingDirectory = yield* fileSystemContext.getCwd(
      context.conversationId
        ? { agentId: agent.id, conversationId: context.conversationId }
        : { agentId: agent.id },
    );
    yield* terminal.log(fmt.keyValueCompact("Directory", workingDirectory));

    yield* terminal.log(fmt.blank());
    yield* terminal.log(fmt.keyValueCompact("Duration", duration));
    yield* terminal.log(fmt.keyValueCompact("Messages", `${context.conversationHistory.length}`));

    const { promptTokens, completionTokens } = context.sessionUsage;
    const totalTokens = promptTokens + completionTokens;
    yield* terminal.log(
      fmt.keyValueCompact(
        "Tokens",
        `${totalTokens.toLocaleString()} (in: ${promptTokens.toLocaleString()}, out: ${completionTokens.toLocaleString()})`,
      ),
    );

    // Estimated cost
    const meta = yield* Effect.promise(() =>
      getModelsDevMetadata(agent.config.llmModel, agent.config.llmProvider),
    );
    const inputPricePerMillion = meta?.inputPricePerMillion ?? 0;
    const outputPricePerMillion = meta?.outputPricePerMillion ?? 0;
    const inputCost = (promptTokens / 1_000_000) * inputPricePerMillion;
    const outputCost = (completionTokens / 1_000_000) * outputPricePerMillion;
    const totalCost = inputCost + outputCost;
    yield* terminal.log(fmt.keyValueCompact("Est. cost", formatUsd(totalCost)));

    yield* terminal.log(fmt.blank());
    return { shouldContinue: true };
  });
}

/**
 * Handle /mcp command - Show MCP server status and connections
 */
function handleMcpCommand(
  terminal: TerminalService,
): Effect.Effect<CommandResult, never, MCPServerManager | AgentConfigService> {
  return Effect.gen(function* () {
    const mcpManager = yield* MCPServerManagerTag;
    const servers = yield* mcpManager.listServers();

    yield* terminal.log(fmt.heading("MCP Servers"));

    if (servers.length === 0) {
      yield* terminal.info("No MCP servers configured.");
      yield* terminal.log(fmt.keyValueCompact("Config", "~/.jazz/config.json"));
      yield* terminal.log(fmt.blank());
      return { shouldContinue: true };
    }

    for (const server of servers) {
      const connected = yield* mcpManager.isConnected(server.name);
      const enabledStr = server.enabled === false ? "disabled" : "enabled";
      const connectedStr = connected ? "connected" : "disconnected";

      if (connected) {
        yield* terminal.log(fmt.statusConnected(server.name));
      } else {
        yield* terminal.log(fmt.statusDisconnected(server.name));
      }
      yield* terminal.log(fmt.keyValue("Status", `${enabledStr}, ${connectedStr}`));
      yield* terminal.log(fmt.keyValue("Transport", server.transport ?? "stdio"));

      if (isStdioConfig(server)) {
        const cmd = `${server.command}${server.args?.length ? " " + server.args.join(" ") : ""}`;
        yield* terminal.log(fmt.keyValue("Command", cmd));
      } else if (isHttpConfig(server)) {
        yield* terminal.log(fmt.keyValue("URL", server.url));
      }

      yield* terminal.log(fmt.blank());
    }

    yield* terminal.log(fmt.footer(`Total: ${servers.length} server(s)`));
    yield* terminal.log(fmt.blank());
    return { shouldContinue: true };
  });
}

/**
 * Handle /mode command - Switch between safe mode and yolo mode
 */
function handleModeCommand(
  terminal: TerminalService,
  args: string[],
  currentPolicy?: AutoApprovePolicy,
  autoApprovedCommands?: readonly string[],
  persistedAutoApprovedCommands?: readonly string[],
  autoApprovedTools?: readonly string[],
): Effect.Effect<CommandResult, never, never> {
  return Effect.gen(function* () {
    const modeArg = args[0]?.toLowerCase();

    if (modeArg === "allow") {
      const pattern = args.slice(1).join(" ").trim();
      if (!pattern) {
        yield* terminal.error("Usage: /mode allow <command prefix>");
        yield* terminal.info("Example: /mode allow git status");
        yield* terminal.log("");
        return { shouldContinue: true };
      }
      yield* terminal.success(`Auto-approving command: ${pattern}`);
      yield* terminal.log("");
      return { shouldContinue: true, addAutoApprovedCommand: pattern };
    }

    if (modeArg === "disallow") {
      const pattern = args.slice(1).join(" ").trim();
      if (!pattern) {
        yield* terminal.error("Usage: /mode disallow <command prefix>");
        yield* terminal.log("");
        return { shouldContinue: true };
      }
      yield* terminal.success(`Removed auto-approval for: ${pattern}`);
      yield* terminal.log("");
      return { shouldContinue: true, removeAutoApprovedCommand: pattern };
    }

    if (modeArg === "safe") {
      yield* terminal.success("Switched to safe mode — all tool calls require approval");
      yield* terminal.log("");
      return { shouldContinue: true, newAutoApprovePolicy: false as const };
    }

    if (modeArg === "yolo") {
      yield* terminal.success("Switched to yolo mode — all tool calls auto-approved");
      yield* terminal.log("");
      return { shouldContinue: true, newAutoApprovePolicy: true as const };
    }

    if (modeArg) {
      yield* terminal.error(`Unknown mode: ${modeArg}`);
      yield* terminal.info("Available modes: safe, yolo, allow <cmd>, disallow <cmd>");
      yield* terminal.log("");
      return { shouldContinue: true };
    }

    // Interactive: show select prompt
    const isSafe = !currentPolicy;
    const isYolo = currentPolicy === true || currentPolicy === "high-risk";
    const selected = yield* terminal.select<string>("Select tool approval mode:", {
      choices: [
        {
          name: `safe — require approval for every tool call${isSafe ? " (current)" : ""}`,
          value: "safe",
        },
        { name: `yolo — auto-approve all tool calls${isYolo ? " (current)" : ""}`, value: "yolo" },
      ],
    });

    // Show auto-approved commands if any
    if (autoApprovedCommands?.length) {
      const persistedSet = new Set(persistedAutoApprovedCommands ?? []);
      yield* terminal.log(fmt.blank());
      yield* terminal.log(fmt.section("Auto-approved Commands"));
      for (const cmd of autoApprovedCommands) {
        const suffix = persistedSet.has(cmd) ? "(always)" : "(session)";
        yield* terminal.log(fmt.itemWithDesc(cmd, suffix));
      }
    }

    // Show auto-approved tools if any
    if (autoApprovedTools?.length) {
      yield* terminal.log(fmt.blank());
      yield* terminal.log(fmt.section("Auto-approved Tools"));
      for (const tool of autoApprovedTools) {
        yield* terminal.log(fmt.item(tool));
      }
    }

    if (!selected) {
      return { shouldContinue: true };
    }

    if (selected === "yolo") {
      yield* terminal.success("Switched to yolo mode — all tool calls auto-approved");
      yield* terminal.log("");
      return { shouldContinue: true, newAutoApprovePolicy: true as const };
    }

    yield* terminal.success("Switched to safe mode — all tool calls require approval");
    yield* terminal.log("");
    return { shouldContinue: true, newAutoApprovePolicy: false as const };
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
 * Get context window size for a specific model from models.dev.
 * Pass provider when known so provider-scoped metadata is used
 * otherwise model-only lookup can return another provider's limits.
 */
function getModelContextWindowEffect(
  modelId: string,
  providerId?: string,
): Effect.Effect<number, never, never> {
  return Effect.tryPromise({
    try: async () => {
      const meta = await getModelsDevMetadata(modelId, providerId);
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

  // Estimate system prompt tokens, separating out the skills catalog
  let systemPromptTokens = systemMessage ? estimateMessageTokens(systemMessage) : 0;
  let skillsTokens = 0;

  // Extract skill catalog tokens from system prompt
  if (systemMessage?.content) {
    const skillsMatch = systemMessage.content.match(
      /\nSkills:\n[\s\S]*?<available_skills>[\s\S]*?<\/available_skills>\n/,
    );
    if (skillsMatch) {
      const catalogTokens = Math.ceil(skillsMatch[0].length / 4);
      skillsTokens += catalogTokens;
      systemPromptTokens -= catalogTokens;
    }
  }

  // Tool tokens are estimated from tool calls in messages
  let toolsTokens = 0;
  let messagesTokens = 0;

  for (const msg of otherMessages) {
    const tokens = estimateMessageTokens(msg);
    if (msg.role === "tool" && (msg.name === "load_skill" || msg.name === "load_skill_section")) {
      // Loaded skill content counts as skills, not tools
      skillsTokens += tokens;
    } else if (msg.role === "tool" || (msg.role === "assistant" && msg.tool_calls)) {
      toolsTokens += tokens;
    } else {
      messagesTokens += tokens;
    }
  }

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
    const contextWindow = yield* getModelContextWindowEffect(modelId, provider);

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
    yield* terminal.log(fmt.heading("Context Usage"));

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

/**
 * Format a small USD amount for display (e.g. 0.0012 → "$0.0012", 0 → "$0.00").
 */
function formatUsd(amount: number): string {
  if (amount === 0) return "$0.00";
  if (amount >= 0.01) return `$${amount.toFixed(2)}`;
  if (amount >= 0.0001) return `$${amount.toFixed(4)}`;
  return `$${amount.toExponential(2)}`;
}

/**
 * Handle /cost command - Show conversation token usage and estimated cost
 */
function handleCostCommand(
  terminal: TerminalService,
  agent: CommandContext["agent"],
  sessionUsage: { promptTokens: number; completionTokens: number },
): Effect.Effect<CommandResult, never, never> {
  return Effect.gen(function* () {
    yield* terminal.log(fmt.heading("Conversation Cost"));

    const { promptTokens, completionTokens } = sessionUsage;
    const totalTokens = promptTokens + completionTokens;

    yield* terminal.log(
      fmt.keyValueCompact("Model", `${agent.config.llmProvider}/${agent.config.llmModel}`),
    );
    yield* terminal.log(fmt.keyValueCompact("Input tokens", promptTokens.toLocaleString()));
    yield* terminal.log(fmt.keyValueCompact("Output tokens", completionTokens.toLocaleString()));
    yield* terminal.log(fmt.keyValueCompact("Total tokens", totalTokens.toLocaleString()));

    if (totalTokens === 0) {
      yield* terminal.log(fmt.blank());
      yield* terminal.info("No tokens used yet in this conversation.");
      yield* terminal.log(fmt.blank());
      return { shouldContinue: true };
    }

    const meta = yield* Effect.promise(() =>
      getModelsDevMetadata(agent.config.llmModel, agent.config.llmProvider),
    );

    const inputPricePerMillion = meta?.inputPricePerMillion ?? 0;
    const outputPricePerMillion = meta?.outputPricePerMillion ?? 0;

    yield* terminal.log(fmt.blank());
    yield* terminal.log(fmt.section("Pricing", undefined, undefined));
    yield* terminal.log(fmt.keyValue("Input", `$${inputPricePerMillion.toFixed(2)}/1M tokens`));
    yield* terminal.log(fmt.keyValue("Output", `$${outputPricePerMillion.toFixed(2)}/1M tokens`));

    const inputCost = (promptTokens / 1_000_000) * inputPricePerMillion;
    const outputCost = (completionTokens / 1_000_000) * outputPricePerMillion;
    const totalCost = inputCost + outputCost;

    yield* terminal.log(fmt.blank());
    yield* terminal.log(fmt.section("Estimated Cost"));
    yield* terminal.log(fmt.keyValue("Input", formatUsd(inputCost)));
    yield* terminal.log(fmt.keyValue("Output", formatUsd(outputCost)));
    yield* terminal.log(fmt.keyValue("Total", formatUsd(totalCost)));

    if (meta?.inputPricePerMillion === undefined && meta?.outputPricePerMillion === undefined) {
      yield* terminal.log(fmt.blank());
      yield* terminal.warn(
        "Pricing not available for this model on models.dev; total shown as $0.00.",
      );
    }

    yield* terminal.log(fmt.blank());
    return { shouldContinue: true };
  });
}
