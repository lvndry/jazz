import { FileSystem } from "@effect/platform";
import { checkbox, input, search, select } from "@inquirer/prompts";
import { Effect } from "effect";
import { agentPromptBuilder } from "../../core/agent/agent-prompt";
import { AgentRunner, type AgentRunnerOptions } from "../../core/agent/agent-runner";
import { getAgentByIdentifier } from "../../core/agent/agent-service";
import {
  FILE_MANAGEMENT_CATEGORY,
  GIT_CATEGORY,
  GMAIL_CATEGORY,
  HTTP_CATEGORY,
  SHELL_COMMANDS_CATEGORY,
  WEB_SEARCH_CATEGORY,
  createCategoryMappings,
} from "../../core/agent/tools/register-tools";
import { normalizeToolConfig } from "../../core/agent/utils/tool-config";
import type { ProviderName } from "../../core/constants/models";
import { AgentConfigServiceTag, type AgentConfigService } from "../../core/interfaces/agent-config";
import { AgentServiceTag, type AgentService } from "../../core/interfaces/agent-service";
import {
  FileSystemContextServiceTag,
  type FileSystemContextService,
} from "../../core/interfaces/fs";
import { LLMServiceTag, type LLMService } from "../../core/interfaces/llm";
import { LoggerServiceTag, type LoggerService } from "../../core/interfaces/logger";
import { TerminalServiceTag, type TerminalService } from "../../core/interfaces/terminal";
import { ToolRegistryTag, type ToolRegistry } from "../../core/interfaces/tool-registry";
import {
  AgentAlreadyExistsError,
  AgentConfigurationError,
  AgentNotFoundError,
  LLMAuthenticationError,
  LLMConfigurationError,
  LLMRateLimitError,
  LLMRequestError,
  StorageError,
  StorageNotFoundError,
  ValidationError,
} from "../../core/types/errors";
import type { Agent, AgentConfig } from "../../core/types/index";
import { type ChatMessage } from "../../core/types/message";
import { CommonSuggestions } from "../../core/utils/error-handler";

/**
 * CLI commands for AI-powered chat agent management
 *
 * These commands handle conversational AI agents that can interact with users through
 * natural language chat interfaces. They integrate with LLM providers and support
 * interactive creation wizards, real-time chat, and tool usage.
 */

/**
 * Configuration for predefined agent types
 */
interface PredefinedAgent {
  readonly id: string;
  readonly displayName: string;
  readonly emoji: string;
  readonly toolCategoryIds: readonly string[];
}

/**
 * Registry of predefined agents with their configurations
 * Add new predefined agents here as needed
 */
const PREDEFINED_AGENTS: Record<string, PredefinedAgent> = {
  coder: {
    id: "coder",
    displayName: "Coder",
    emoji: "💻",
    toolCategoryIds: [
      FILE_MANAGEMENT_CATEGORY.id,
      SHELL_COMMANDS_CATEGORY.id,
      GIT_CATEGORY.id,
      HTTP_CATEGORY.id,
      WEB_SEARCH_CATEGORY.id,
    ],
  },
  gmail: {
    id: "gmail",
    displayName: "Gmail",
    emoji: "📧",
    toolCategoryIds: [
      GMAIL_CATEGORY.id,
      HTTP_CATEGORY.id,
      WEB_SEARCH_CATEGORY.id,
      FILE_MANAGEMENT_CATEGORY.id,
      SHELL_COMMANDS_CATEGORY.id,
    ],
  },
} as const;

interface AIAgentCreationAnswers {
  name: string;
  description?: string;
  agentType: string;
  llmProvider: ProviderName;
  llmModel: string;
  reasoningEffort?: "disable" | "low" | "medium" | "high";
  tools: string[];
}

/**
 * Interactive AI agent creation command
 */
export function createAgentCommand(): Effect.Effect<
  void,
  | StorageError
  | AgentAlreadyExistsError
  | AgentConfigurationError
  | ValidationError
  | LLMConfigurationError,
  AgentService | LLMService | ToolRegistry | TerminalService | AgentConfigService
> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    yield* terminal.heading("🤖 Welcome to the Jazz AI Agent Creation Wizard!");
    yield* terminal.log("Let's create a new AI agent step by step.");
    yield* terminal.log("");

    const llmService = yield* LLMServiceTag;
    const configService = yield* AgentConfigServiceTag;
    const toolRegistry = yield* ToolRegistryTag;

    const agentTypes = yield* agentPromptBuilder.listTemplates();
    const toolsByCategory = yield* toolRegistry.listToolsByCategory();

    const categoryMappings = createCategoryMappings();
    const categoryDisplayNameToId: Map<string, string> = categoryMappings.displayNameToId;
    const categoryIdToDisplayName: Map<string, string> = categoryMappings.idToDisplayName;

    // Get agent basic information
    const agentAnswers = yield* Effect.promise(() =>
      promptForAgentInfo(
        agentTypes,
        toolsByCategory,
        llmService,
        configService,
        categoryIdToDisplayName,
        terminal,
      ),
    );

    // Validate the chosen model against the chosen provider
    const chosenProvider = yield* llmService.getProvider(agentAnswers.llmProvider);
    const modelIds: string[] = chosenProvider.supportedModels.map((model) => model.id);
    const selectedModel = modelIds.includes(agentAnswers.llmModel)
      ? agentAnswers.llmModel
      : chosenProvider.defaultModel;

    // Convert selected categories (display names) to category IDs, then get tools
    const selectedCategoryIds = agentAnswers.tools
      .map((displayName) => categoryDisplayNameToId.get(displayName))
      .filter((id): id is string => id !== undefined);

    // Get tools for each selected category ID
    const selectedToolNames = yield* Effect.all(
      selectedCategoryIds.map((categoryId) => toolRegistry.getToolsInCategory(categoryId)),
      { concurrency: "unbounded" },
    );
    const uniqueToolNames = Array.from(new Set(selectedToolNames.flat()));

    // Build agent configuration
    const config: AgentConfig = {
      agentType: agentAnswers.agentType,
      llmProvider: agentAnswers.llmProvider,
      llmModel: selectedModel,
      ...(agentAnswers.reasoningEffort && { reasoningEffort: agentAnswers.reasoningEffort }),
      ...(uniqueToolNames.length > 0 && { tools: uniqueToolNames }),
    };

    const agentService = yield* AgentServiceTag;
    const agent = yield* agentService.createAgent(
      agentAnswers.name,
      agentAnswers.description,
      config,
    );

    // Display success message
    yield* terminal.success("AI Agent created successfully!");
    yield* terminal.log(`   ID: ${agent.id}`);
    yield* terminal.log(`   Name: ${agent.name}`);
    if (agent.description) {
      yield* terminal.log(`   Description: ${agent.description}`);
    }
    yield* terminal.log(`   Type: ${config.agentType}`);
    yield* terminal.log(`   LLM Provider: ${config.llmProvider}`);
    yield* terminal.log(`   LLM Model: ${config.llmModel}`);
    yield* terminal.log(`   Reasoning: ${config.reasoningEffort}`);
    yield* terminal.log(`   Tool Categories: ${agentAnswers.tools.join(", ") || "None"}`);
    yield* terminal.log(`   Total Tools: ${uniqueToolNames.length}`);
    yield* terminal.log(`   Created: ${agent.createdAt.toISOString()}`);
    yield* terminal.log("");
    yield* terminal.info("You can now chat with your agent using:");
    yield* terminal.log(`   • By ID:   jazz agent chat ${agent.id}`);
    yield* terminal.log(`   • By name: jazz agent chat ${agent.name}`);
  });
}

/**
 * Prompt for basic agent information with new flow:
 * 1. Provider selection
 * 2. API key check/input if needed
 * 3. Agent type
 * 4. Name
 * 5. Description (if default)
 * 6. Model selection
 * 7. Reasoning effort (if applicable)
 * 8. Tools (if not predefined)
 */
async function promptForAgentInfo(
  agentTypes: readonly string[],
  toolsByCategory: Record<string, readonly string[]>,
  llmService: LLMService,
  configService: AgentConfigService,
  categoryIdToDisplayName: Map<string, string>,
  terminal: TerminalService,
): Promise<AIAgentCreationAnswers> {
  const allProviders = await Effect.runPromise(llmService.listProviders());

  const llmProvider = await search<ProviderName>({
    message: "Which LLM provider would you like to use?",
    source: (term) => {
      const choices = allProviders.map((p) => ({
        name: p.name,
        value: p.name,
      }));

      if (!term) {
        return choices;
      }

      return choices.filter((choice) => choice.name.toLowerCase().includes(term.toLowerCase()));
    },
  });

  // STEP 2.A: Check if API key exists for the selected provider
  const providerName = llmProvider;
  const apiKeyPath = `llm.${providerName}.api_key`;
  const hasApiKey = await Effect.runPromise(configService.has(apiKeyPath));

  if (!hasApiKey) {
    // Show message and prompt for API key
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* terminal.log("");
        yield* terminal.warn(`API key not set in config file for ${providerName}.`);
        yield* terminal.log("Please paste your API key below:");
      }),
    );

    const isOptional = providerName === "ollama";

    const apiKey = await input({
      message: `${providerName} API Key${isOptional ? " (optional)" : ""} :`,
      validate: (inputValue: string): boolean | string => {
        if (isOptional) {
          return true;
        }

        if (!inputValue || inputValue.trim().length === 0) {
          return "API key cannot be empty";
        }

        return true;
      },
    });

    // Update config with the new API key
    await Effect.runPromise(configService.set(apiKeyPath, apiKey));

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* terminal.success("API key saved to config file.");
        yield* terminal.log("");
      }),
    );
  }

  // STEP 2.B: Select Model
  const chosenProviderInfo = await Effect.runPromise(llmService.getProvider(llmProvider)).catch(
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to get provider info: ${message}`);
    },
  );

  const llmModel = await search<string>({
    message: "Which model would you like to use?",
    source: (term) => {
      const allModels = chosenProviderInfo.supportedModels.map((model) => ({
        name: model.displayName || model.id,
        description: model.displayName || model.id,
        value: model.id,
      }));

      if (!term) {
        return allModels;
      }

      return allModels.filter(
        (choice) =>
          choice.name.toLowerCase().includes(term.toLowerCase()) ||
          choice.value.toLowerCase().includes(term.toLowerCase()),
      );
    },
  });

  // Check if it's a reasoning model and ask for effort if needed
  const selectedModel = chosenProviderInfo.supportedModels.find((m) => m.id === llmModel);
  let reasoningEffort: "disable" | "low" | "medium" | "high" | undefined;
  if (selectedModel?.isReasoningModel) {
    reasoningEffort = await select<"disable" | "low" | "medium" | "high">({
      message: "What reasoning effort level would you like?",
      choices: [
        { name: "Low - Faster responses, basic reasoning", value: "low" },
        {
          name: "Medium - Balanced speed and reasoning depth (recommended)",
          value: "medium",
        },
        { name: "High - Deep reasoning, slower responses", value: "high" },
        { name: "Disable - No reasoning effort (fastest)", value: "disable" },
      ],
      default: "medium",
    });
  }

  // STEP 3: Ask for agent type
  const agentType = await select<string>({
    message: "What type of agent would you like to create?",
    choices: agentTypes,
    default: "default",
  });

  // STEP 4: Ask for name
  const name = await input({
    message: "What would you like to name your AI agent?",
    validate: (inputValue: string): boolean | string => {
      if (!inputValue || inputValue.trim().length === 0) {
        return "Agent name cannot be empty";
      }
      if (inputValue.length > 100) {
        return "Agent name cannot exceed 100 characters";
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(inputValue)) {
        return "Agent name can only contain letters, numbers, underscores, and hyphens";
      }
      return true;
    },
  });

  // STEP 5: Ask for description only if agent type is "default"
  let description: string | undefined;
  if (agentType === "default") {
    description = await input({
      message: "Describe what this AI agent will do:",
      validate: (inputValue: string): boolean | string => {
        if (!inputValue || inputValue.trim().length === 0) {
          return "Agent description cannot be empty";
        }
        if (inputValue.length > 500) {
          return "Agent description cannot exceed 500 characters";
        }
        return true;
      },
    });
  }

  // STEP 6: Tools selection
  // Check if this is a predefined agent with auto-assigned tools
  const currentPredefinedAgent = PREDEFINED_AGENTS[agentType];
  if (currentPredefinedAgent) {
    // Filter to only categories that exist in toolsByCategory (by checking if display name exists)
    const availableCategoryIds = currentPredefinedAgent.toolCategoryIds.filter((categoryId) => {
      const displayName = categoryIdToDisplayName.get(categoryId);
      return displayName && displayName in toolsByCategory;
    });

    const displayNames = availableCategoryIds
      .map((id) => categoryIdToDisplayName.get(id))
      .filter((name): name is string => name !== undefined);

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* terminal.log("");
        yield* terminal.log(
          `${currentPredefinedAgent.emoji} ${currentPredefinedAgent.displayName} agent will automatically include: ${displayNames.join(", ")}`,
        );
        yield* terminal.log("");
      }),
    );
  }

  let tools: string[] = [];

  if (!currentPredefinedAgent) {
    tools = await checkbox<string>({
      message: "Which tools should this agent have access to?",
      choices: Object.entries(toolsByCategory).map(([category, toolsInCategory]) => ({
        name: `${category} (${toolsInCategory.length} ${toolsInCategory.length === 1 ? "tool" : "tools"})`,
        value: category,
      })),
    });
  }

  // Calculate final tools
  const finalTools = currentPredefinedAgent
    ? currentPredefinedAgent.toolCategoryIds
        .map((id) => categoryIdToDisplayName.get(id))
        .filter((name): name is string => name !== undefined && name in toolsByCategory)
    : tools;

  return {
    llmProvider,
    llmModel,
    ...(reasoningEffort && { reasoningEffort }),
    agentType,
    name,
    ...(description && { description }),
    tools: finalTools,
  };
}

/**
 * Chat with an AI agent
 */
export function chatWithAIAgentCommand(
  agentIdentifier: string,
  options?: {
    stream?: boolean;
  },
) {
  return Effect.gen(function* () {
    const normalizedIdentifier = agentIdentifier.trim();

    if (normalizedIdentifier.length === 0) {
      return yield* Effect.fail(
        new AgentNotFoundError({
          agentId: normalizedIdentifier,
          suggestion: CommonSuggestions.checkAgentExists("<empty>"),
        }),
      );
    }

    const agent = yield* getAgentByIdentifier(normalizedIdentifier).pipe(
      Effect.catchTag("StorageNotFoundError", () =>
        Effect.fail(
          new AgentNotFoundError({
            agentId: normalizedIdentifier,
            suggestion: CommonSuggestions.checkAgentExists(normalizedIdentifier),
          }),
        ),
      ),
    );

    const terminal = yield* TerminalServiceTag;
    yield* terminal.heading(`🤖 Starting chat with AI agent: ${agent.name} (${agent.id})`);
    if (agent.description) {
      yield* terminal.log(`   Description: ${agent.description}`);
    }
    yield* terminal.log("");
    yield* terminal.info("Type '/exit' to end the conversation.");
    yield* terminal.info("Type '/help' to see available special commands.");
    yield* terminal.log("");

    // Start the chat loop with error logging
    yield* startChatLoop(agent, options).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          const logger = yield* LoggerServiceTag;
          yield* logger.error("Chat loop error", { error });
          yield* terminal.error(
            `Chat loop error: ${error instanceof Error ? error.message : String(error)}`,
          );
          return yield* Effect.void;
        }),
      ),
    );
  });
}

function initializeSession(
  agent: Agent,
  conversationId: string,
): Effect.Effect<
  void,
  Error,
  FileSystemContextService | LoggerService | FileSystem.FileSystem | AgentConfigService
> {
  return Effect.gen(function* () {
    const agentKey = { agentId: agent.id, conversationId };
    const fileSystemContext = yield* FileSystemContextServiceTag;
    const logger = yield* LoggerServiceTag;
    yield* fileSystemContext.setCwd(agentKey, process.cwd());
    yield* logger.info(`Initialized agent working directory to: ${process.cwd()}`);
  });
}
/**
 * Special command types
 */
type SpecialCommand = {
  type: "new" | "help" | "status" | "clear" | "tools" | "agents" | "switch" | "unknown";
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
): Effect.Effect<
  {
    shouldContinue: boolean;
    newConversationId?: string | undefined;
    newHistory?: ChatMessage[];
    newAgent?: Agent;
  },
  StorageError | StorageNotFoundError,
  ToolRegistry | TerminalService | AgentService
> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    switch (command.type) {
      case "new":
        yield* terminal.info("Starting new conversation...");
        yield* terminal.log("   • Conversation context cleared");
        yield* terminal.log("   • Fresh start with the agent");
        yield* terminal.log("");
        return {
          shouldContinue: true,
          newConversationId: undefined,
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

        const selectedAgentId = yield* Effect.promise(() =>
          select<string>({
            message: "Select an agent to switch to:",
            choices,
            default: agent.id,
          }),
        );

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
 * Chat loop for interacting with the AI agent
 */
function startChatLoop(
  agent: Agent,
  loopOptions?: {
    stream?: boolean;
  },
) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    let chatActive = true;
    let conversationId: string | undefined;
    let conversationHistory: ChatMessage[] = [];
    let sessionInitialized = false;

    while (chatActive) {
      // Prompt for user input
      const userMessage = yield* Effect.promise(() =>
        input({
          message: "You:",
        }).catch((error: unknown) => {
          // Handle ExitPromptError from inquirer when user presses Ctrl+C
          if (
            error instanceof Error &&
            (error.name === "ExitPromptError" || error.message.includes("SIGINT"))
          ) {
            // Exit gracefully on Ctrl+C - return /exit to trigger normal exit flow
            // The exit check below will handle the goodbye message
            return "/exit";
          }
          // Re-throw other errors, ensuring it's an Error instance
          throw error instanceof Error ? error : new Error(String(error));
        }),
      );

      const trimmedMessage = userMessage.trim();
      const lowerMessage = trimmedMessage.toLowerCase();
      if (lowerMessage === "/exit" || lowerMessage === "exit" || lowerMessage === "quit") {
        yield* terminal.info("👋 Goodbye!");
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
        const commandResult = yield* handleSpecialCommand(
          specialCommand,
          agent,
          conversationId,
          conversationHistory,
        );

        if (commandResult.newConversationId !== undefined) {
          conversationId = commandResult.newConversationId;
        }
        if (commandResult.newAgent !== undefined) {
          agent = commandResult.newAgent;
        }
        if (commandResult.newHistory !== undefined) {
          conversationHistory = commandResult.newHistory;
        }

        continue;
      }

      // Use Effect.catchAll instead of try-catch for proper Effect error handling
      yield* Effect.gen(function* () {
        if (!sessionInitialized) {
          yield* initializeSession(agent, conversationId || "").pipe(
            Effect.catchAll((error) =>
              Effect.gen(function* () {
                const logger = yield* LoggerServiceTag;
                yield* logger.error("Session initialization error", { error });
              }),
            ),
          );

          sessionInitialized = true;
        }

        // Create runner options
        const options: AgentRunnerOptions = {
          agent,
          userInput: userMessage,
          conversationId: conversationId || "",
          conversationHistory,
          ...(loopOptions?.stream !== undefined ? { stream: loopOptions.stream } : {}),
        };

        // Run the agent with proper error handling
        const response = yield* AgentRunner.run(options).pipe(
          Effect.catchAll((error) =>
            Effect.gen(function* () {
              const logger = yield* LoggerServiceTag;

              // Log error with detailed information
              const errorDetails: Record<string, unknown> = {
                agentId: agent.id,
                conversationId: conversationId || undefined,
                errorMessage: error instanceof Error ? error.message : String(error),
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
                yield* terminal.error(`LLM request failed: ${error.message}`);
                yield* terminal.log("   This might be a temporary issue. Please try again.");
              } else {
                yield* terminal.error(
                  `Error: ${error instanceof Error ? error.message : String(error)}`,
                );
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

        // Persist conversation history for next turn
        if (response.messages) {
          conversationHistory = response.messages;
        }

        // Display is handled entirely by AgentRunner (both streaming and non-streaming)
        // No need to display here - AgentRunner takes care of it
      });
    }
  });
}
