import { Effect } from "effect";
import { agentPromptBuilder } from "@/core/agent/agent-prompt";
import { registerMCPServerTools } from "@/core/agent/tools/mcp-tools";
import {
  createCategoryMappings,
  FILE_MANAGEMENT_CATEGORY,
  getMCPServerCategories,
  GIT_CATEGORY,
  GMAIL_CATEGORY,
  HTTP_CATEGORY,
  SHELL_COMMANDS_CATEGORY,
  WEB_SEARCH_CATEGORY,
} from "@/core/agent/tools/register-tools";
import type { ProviderName } from "@/core/constants/models";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
import { AgentServiceTag, type AgentService } from "@/core/interfaces/agent-service";
import { LLMServiceTag, type LLMService } from "@/core/interfaces/llm";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import { MCPServerManagerTag, type MCPServerManager } from "@/core/interfaces/mcp-server";
import { TerminalServiceTag, type TerminalService } from "@/core/interfaces/terminal";
import { ToolRegistryTag, type ToolRegistry } from "@/core/interfaces/tool-registry";
import {
  AgentAlreadyExistsError,
  AgentConfigurationError,
  LLMConfigurationError,
  StorageError,
  ValidationError,
} from "@/core/types/errors";
import type { AgentConfig, LLMProviderListItem } from "@/core/types/index";
import type { MCPTool } from "@/core/types/mcp";
import { isAuthenticationRequired } from "@/core/utils/mcp-utils";
import { toPascalCase } from "@/core/utils/string";

/**
 * CLI commands for creating AI agents
 *
 * These commands handle the interactive creation of AI agents through
 * a step-by-step wizard that guides users through configuration.
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
  AgentService | LLMService | ToolRegistry | TerminalService | AgentConfigService | MCPServerManager | LoggerService
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
    let toolsByCategory = yield* toolRegistry.listToolsByCategory();

    const mcpServerData = yield* getMCPServerCategories();
    toolsByCategory = { ...toolsByCategory, ...mcpServerData.categories };

    const categoryMappings = createCategoryMappings();
    const categoryDisplayNameToId: Map<string, string> = categoryMappings.displayNameToId;
    const categoryIdToDisplayName: Map<string, string> = categoryMappings.idToDisplayName;

    // Add MCP server category mappings (category ID format: mcp_<servername>)
    for (const [displayName, serverName] of mcpServerData.displayNameToServerName.entries()) {
      const categoryId = `mcp_${serverName.toLowerCase()}`;
      categoryDisplayNameToId.set(displayName, categoryId);
    }

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

    // Handle MCP server selections - register tools for selected MCP servers
    const mcpManager = yield* MCPServerManagerTag;
    const logger = yield* LoggerServiceTag;
    const selectedMCPDisplayNames = agentAnswers.tools.filter((displayName) =>
      mcpServerData.displayNameToServerName.has(displayName),
    );

    // Register tools for selected MCP servers
    if (selectedMCPDisplayNames.length > 0) {
      const selectedServerNames = selectedMCPDisplayNames.map(
        (displayName) => mcpServerData.displayNameToServerName.get(displayName)!,
      );
      const allServers = yield* mcpManager.listServers();
      const selectedServers = allServers.filter((server) =>
        selectedServerNames.includes(server.name),
      );

      // Register tools from all selected MCP servers in parallel with timeout
      const registrationEffects = selectedServers.map((serverConfig) =>
        Effect.gen(function* () {
          yield* logger.debug(`Registering tools from MCP server ${serverConfig.name}...`);

          // Discover tools from server with timeout (45 seconds per server to allow for authentication)
          const mcpTools = yield* mcpManager.discoverTools(serverConfig).pipe(
            Effect.timeout("45 seconds"),
            Effect.catchAll((error) =>
              Effect.gen(function* () {
                const errorMessage =
                  error instanceof Error ? error.message : String(error);
                const isAuthRequired = isAuthenticationRequired(error);

                if (errorMessage.includes("timeout") || errorMessage.includes("Timeout")) {
                  if (isAuthRequired) {
                    yield* logger.warn(
                      `MCP server ${toPascalCase(serverConfig.name)} connection timed out after 30 seconds. The server may be waiting for authentication. Please check if manual authentication is required.`,
                    );
                  } else {
                    yield* logger.warn(
                      `MCP server ${toPascalCase(serverConfig.name)} connection timed out after 30 seconds`,
                    );
                  }
                } else if (isAuthRequired) {
                  yield* logger.warn(
                    `MCP server ${toPascalCase(serverConfig.name)} requires authentication: ${errorMessage}`,
                  );
                } else {
                  yield* logger.warn(
                    `Failed to connect to MCP server ${toPascalCase(serverConfig.name)}: ${errorMessage}`,
                  );
                }
                // Return empty array on error/timeout
                return [] as readonly MCPTool[];
              }),
            ),
          );

          if (mcpTools.length === 0) {
            return;
          }

          // Determine category for tools
          const category = {
            id: `mcp_${serverConfig.name.toLowerCase()}`,
            displayName: `${toPascalCase(serverConfig.name)} (MCP)`,
          };

          // Register tools
          const registerTool = toolRegistry.registerForCategory(category);
          const jazzTools = yield* registerMCPServerTools(serverConfig, mcpTools);

          for (const tool of jazzTools) {
            yield* registerTool(tool);
          }

          yield* logger.info(
            `Registered ${jazzTools.length} tools from MCP server ${serverConfig.name}`,
          );
        }).pipe(
          Effect.catchAll(() =>
            Effect.gen(function* () {
              // If registration fails, continue without this server's tools
              yield* logger.warn(`Failed to register tools from MCP server ${serverConfig.name}`);
            }),
          ),
        ),
      );

      // Run all registrations in parallel
      yield* Effect.all(registrationEffects, { concurrency: "unbounded" });

      // Refresh tools list after MCP registration
      toolsByCategory = yield* toolRegistry.listToolsByCategory();
    }

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
  const allProviders: readonly LLMProviderListItem[] = await Effect.runPromise(llmService.listProviders());

  const llmProvider = await Effect.runPromise(
    terminal.search<ProviderName>("Which LLM provider would you like to use?", {
      choices: allProviders.map((provider) => ({
        name: provider.displayName ?? provider.name,
        value: provider.name,
      })),
    }),
  );

  if (!llmProvider) {
    throw new Error("Agent creation cancelled");
  }

  // STEP 2.A: Check if API key exists for the selected provider
  const providerName = llmProvider;
  const providerDisplayName =
    allProviders.find((provider) => provider.name === providerName)?.displayName ?? providerName;
  const apiKeyPath = `llm.${providerName}.api_key`;
  const hasApiKey = await Effect.runPromise(configService.has(apiKeyPath));

  if (!hasApiKey) {
    // Show message and prompt for API key
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* terminal.log("");
        yield* terminal.warn(`API key not set in config file for ${providerDisplayName}.`);
        yield* terminal.log("Please paste your API key below:");
      }),
    );

    const isOptional = providerName === "ollama";

    const apiKey = await Effect.runPromise(
      terminal.ask(`${providerDisplayName} API Key${isOptional ? " (optional)" : ""} :`, {
        validate: (inputValue: string): boolean | string => {
          if (isOptional) {
            return true;
          }

          if (!inputValue || inputValue.trim().length === 0) {
            return "API key cannot be empty";
          }

          return true;
        },
      }),
    );

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

  const llmModel = await Effect.runPromise(
    terminal.search<string>("Which model would you like to use?", {
      choices: chosenProviderInfo.supportedModels.map((model) => ({
        name: model.displayName || model.id,
        description: model.displayName || model.id,
        value: model.id,
      })),
    }),
  );

  if (!llmModel) {
    throw new Error("Agent creation cancelled");
  }

  // Check if it's a reasoning model and ask for effort if needed
  const selectedModel = chosenProviderInfo.supportedModels.find((m) => m.id === llmModel);
  let reasoningEffort: "disable" | "low" | "medium" | "high" | undefined;
  if (selectedModel?.isReasoningModel) {
    const selectedEffort = await Effect.runPromise(
      terminal.select<"disable" | "low" | "medium" | "high">(
        "What reasoning effort level would you like?",
        {
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
        },
      ),
    );
    if (!selectedEffort) {
      throw new Error("Agent creation cancelled");
    }
    reasoningEffort = selectedEffort;
  }

  // STEP 3: Ask for agent type
  const agentType = await Effect.runPromise(
    terminal.select<string>("What type of agent would you like to create?", {
      choices: agentTypes,
      default: "default",
    }),
  );

  if (!agentType) {
    throw new Error("Agent creation cancelled");
  }

  // STEP 4: Ask for name
  const name = await Effect.runPromise(
    terminal.ask("Name of your new agent:", {
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
    }),
  );

  // STEP 5: Ask for description only if agent type is "default"
  let description: string | undefined;
  if (agentType === "default") {
    description = await Effect.runPromise(
      terminal.ask("Describe what this agent will do:", {
        validate: (inputValue: string): boolean | string => {
          if (!inputValue || inputValue.trim().length === 0) {
            return "Agent description cannot be empty";
          }
          if (inputValue.length > 500) {
            return "Agent description cannot exceed 500 characters";
          }
          return true;
        },
      }),
    );
  }

  // STEP 6: Tools selection
  // Check if the selected model supports tools
  const selectedModelInfo = chosenProviderInfo.supportedModels.find((m) => m.id === llmModel);
  const supportsTools = selectedModelInfo?.supportsTools ?? false;

  let tools: string[] = [];
  const currentPredefinedAgent = PREDEFINED_AGENTS[agentType];

  if (!supportsTools) {
    if (currentPredefinedAgent && currentPredefinedAgent.toolCategoryIds.length > 0) {
      await Effect.runPromise(
        terminal.warn(
          `\n⚠️  The selected model (${llmModel}) does not support tools. The "${currentPredefinedAgent.displayName}" agent template's tools will be ignored.`,
        ),
      );
    } else {
      await Effect.runPromise(
        terminal.info(
          `\nℹ️  Skipping tool selection as the selected model (${llmModel}) does not support tools.`,
        ),
      );
    }
  } else if (currentPredefinedAgent) {
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
  } else {
    // Custom agent - manual tool selection
    const selectedTools = await Effect.runPromise(
      terminal.checkbox<string>("Which tools should this agent have access to?", {
        choices: Object.entries(toolsByCategory).map(([category, toolsInCategory]) => ({
          name: toolsInCategory.length > 0
            ? `${category} (${toolsInCategory.length} ${toolsInCategory.length === 1 ? "tool" : "tools"})`
            : category,
          value: category,
        })),
      }),
    );
    tools = [...selectedTools];
  }

  const finalTools = supportsTools
    ? currentPredefinedAgent
      ? currentPredefinedAgent.toolCategoryIds
          .map((id) => categoryIdToDisplayName.get(id))
          .filter((name): name is string => name !== undefined && name in toolsByCategory)
      : tools
    : [];

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
