import { Effect } from "effect";
import { handleWebSearchConfiguration } from "@/cli/helpers/web-search";
import { agentPromptBuilder } from "@/core/agent/agent-prompt";
import { getAgentByIdentifier } from "@/core/agent/agent-service";
import { registerMCPServerTools } from "@/core/agent/tools/mcp-tools";
import {
  createCategoryMappings,
  getMCPServerCategories,
  WEB_SEARCH_CATEGORY,
} from "@/core/agent/tools/register-tools";
import { normalizeToolConfig } from "@/core/agent/utils/tool-config";
import type { ProviderName } from "@/core/constants/models";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
import { AgentServiceTag, type AgentService } from "@/core/interfaces/agent-service";
import { LLMServiceTag, type LLMService } from "@/core/interfaces/llm";
import type { LoggerService } from "@/core/interfaces/logger";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import type { MCPServerManager } from "@/core/interfaces/mcp-server";
import { MCPServerManagerTag } from "@/core/interfaces/mcp-server";
import { TerminalServiceTag, type TerminalService } from "@/core/interfaces/terminal";
import { ToolRegistryTag, type ToolRegistry } from "@/core/interfaces/tool-registry";
import type { Agent, AgentConfig, LLMProvider } from "@/core/types";
import {
  AgentAlreadyExistsError,
  AgentConfigurationError,
  LLMConfigurationError,
  StorageError,
  StorageNotFoundError,
  ValidationError,
} from "@/core/types/errors";
import type { MCPTool } from "@/core/types/mcp";
import { extractServerNamesFromToolNames, isAuthenticationRequired } from "@/core/utils/mcp-utils";
import { toPascalCase } from "@/core/utils/string";

/**
 * CLI commands for editing existing agents
 */

interface AgentEditAnswers {
  name?: string;
  description?: string;
  agentType?: string;
  llmProvider?: ProviderName;
  llmModel?: string;
  reasoningEffort?: "disable" | "low" | "medium" | "high";
  tools?: string[];
}

/**
 * Interactive agent edit command
 */
export function editAgentCommand(
  agentIdentifier: string,
): Effect.Effect<
  void,
  | StorageError
  | StorageNotFoundError
  | AgentConfigurationError
  | AgentAlreadyExistsError
  | ValidationError
  | LLMConfigurationError,
  AgentService | LLMService | ToolRegistry | TerminalService | AgentConfigService | MCPServerManager | LoggerService
> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    yield* terminal.heading("✏️  Welcome to the Jazz Agent Edit Wizard!");
    yield* terminal.log("Let's update your agent step by step.");
    yield* terminal.log("");

    const agent = yield* getAgentByIdentifier(agentIdentifier);
    const agentService = yield* AgentServiceTag;

    yield* terminal.heading(`📋 Current Agent: ${agent.name}`);
    yield* terminal.log(`   ID: ${agent.id}`);
    yield* terminal.log(`   Description: ${agent.description}`);
    yield* terminal.log(`   Type: ${agent.config.agentType || "N/A"}`);
    yield* terminal.log(`   LLM Provider: ${agent.config.llmProvider || "N/A"}`);
    yield* terminal.log(`   LLM Model: ${agent.config.llmModel || "N/A"}`);
    yield* terminal.log(`   Reasoning: ${agent.config.reasoningEffort || "N/A"}`);
    yield* terminal.log(`   Tools: ${agent.config.tools ? agent.config.tools.length : 0} tools`);
    yield* terminal.log(`   Created: ${agent.createdAt.toISOString()}`);
    yield* terminal.log(`   Updated: ${agent.updatedAt.toISOString()}`);
    yield* terminal.log("");

    // Get available LLM providers and models
    const llmService = yield* LLMServiceTag;
    const configService = yield* AgentConfigServiceTag;
    const providers = yield* llmService.listProviders();

    // Get available agent types
    const agentTypes = yield* agentPromptBuilder.listTemplates();

    // Get available tools by category
    const toolRegistry = yield* ToolRegistryTag;
    let toolsByCategory = yield* toolRegistry.listToolsByCategory();

    // Create mappings between category display names and IDs
    const categoryMappings = createCategoryMappings();
    const categoryDisplayNameToId: Map<string, string> = categoryMappings.displayNameToId;

    const mcpServerData = yield* getMCPServerCategories();
    toolsByCategory = { ...toolsByCategory, ...mcpServerData.categories };

    // Add MCP server category mappings (category ID format: mcp_<servername>)
    for (const [displayName, serverName] of mcpServerData.displayNameToServerName.entries()) {
      const categoryId = `mcp_${serverName.toLowerCase()}`;
      categoryDisplayNameToId.set(displayName, categoryId);
    }

    // Get current provider info for model selection
    const currentProviderInfo = yield* llmService
      .getProvider(agent.config.llmProvider)
      .pipe(Effect.catchAll(() => Effect.succeed(null as LLMProvider | null)));

    // Check if current model is reasoning model (needed for field choices)
    const currentModelInfo = currentProviderInfo?.supportedModels.find(
      (model) => model.id === agent.config.llmModel,
    );
    const currentModelIsReasoning = currentModelInfo?.isReasoningModel ?? false;
    const supportsTools = currentModelInfo?.supportsTools ?? false;

    // Auto-cleanup: if model doesn't support tools but agent has them, clear them
    if (!supportsTools && agent.config.tools && agent.config.tools.length > 0) {
      yield* terminal.warn(
        `\n⚠️  The current model (${agent.config.llmModel}) does not support tools. Clearing configured tools.`,
      );

      // Clear tools in the database
      yield* agentService.updateAgent(agent.id, {
        config: { ...agent.config, tools: [] },
      });
    }

    // First, ask what field to update
    const fieldToUpdate = yield* terminal.select<string>("What would you like to update?", {
      choices: [
        { name: "Name", value: "name" },
        { name: "Description", value: "description" },
        { name: "Agent Type", value: "agentType" },
        { name: "LLM Provider", value: "llmProvider" },
        { name: "LLM Model", value: "llmModel" },
        {
          name: supportsTools ? "Tools" : "Tools (Not supported by current model) 🚫",
          value: "tools",
        },
        ...(currentModelIsReasoning ? [{ name: "Reasoning Effort", value: "reasoningEffort" }] : []),
      ],
    });

    if (!fieldToUpdate) {
      yield* terminal.info("Edit cancelled.");
      return;
    }

    // Get logger and MCP manager for use throughout
    const logger = yield* LoggerServiceTag;
    const mcpManager = yield* MCPServerManagerTag;

    // If user selected "tools", connect to all configured MCP servers and discover their tools
    // BEFORE showing the tool selection, so all MCP tools are available
    if (fieldToUpdate === "tools") {
      if (!supportsTools) {
        yield* terminal.warn(`\n⚠️  The current model (${agent.config.llmModel}) does not support tools.`);
        // Re-run the command to let user pick something else, or just exit
        return;
      }

      const allServers = yield* mcpManager.listServers();
      const enabledServers = allServers.filter((server) => server.enabled !== false);

      if (enabledServers.length > 0) {
        yield* terminal.log("Discovering tools from MCP servers...");

        // Discover and register tools from all enabled MCP servers
        const discoveryEffects = enabledServers.map((serverConfig) =>
          Effect.gen(function* () {
            yield* logger.debug(`Discovering tools from MCP server ${serverConfig.name}...`);
            yield* terminal.debug(`Discovering tools from MCP server ${serverConfig.name}...`);

            // Find the display name for this server
            let categoryDisplayName: string | undefined;
            for (const [displayName, serverName] of mcpServerData.displayNameToServerName.entries()) {
              if (serverName === serverConfig.name) {
                categoryDisplayName = displayName;
                break;
              }
            }
            if (!categoryDisplayName) {
              categoryDisplayName = `${toPascalCase(serverConfig.name)} (MCP)`;
            }

            // Discover tools from server with timeout (45 seconds per server to allow for authentication)
            const mcpTools = yield* mcpManager.discoverTools(serverConfig).pipe(
              Effect.timeout("45 seconds"),
              Effect.catchAll((error) =>
                Effect.gen(function* () {
                  // Log detailed error information
                  const errorMessage =
                    error instanceof Error ? error.message : String(error);
                  const errorString = String(error);
                  const errorStack = error instanceof Error ? error.stack : undefined;
                  const isAuthRequired = isAuthenticationRequired(error);

                  // Check for Effect tagged errors
                  let errorDetails = `Type: ${error instanceof Error ? error.constructor.name : typeof error}, Message: ${errorMessage}`;
                  if (typeof error === "object" && error !== null) {
                    if ("_tag" in error) {
                      errorDetails += `, Tag: ${(error as { _tag: string })._tag}`;
                    }
                    if ("reason" in error) {
                      errorDetails += `, Reason: ${(error as { reason: string }).reason}`;
                    }
                    if ("serverName" in error) {
                      errorDetails += `, Server: ${(error as { serverName: string }).serverName}`;
                    }
                    if ("suggestion" in error) {
                      errorDetails += `, Suggestion: ${(error as { suggestion: string }).suggestion}`;
                    }
                  }

                  yield* terminal.debug(
                    `Error discovering tools from ${toPascalCase(serverConfig.name)}: ${errorDetails}${errorStack ? `\nStack: ${errorStack}` : ""}`,
                  );
                  yield* logger.warn(
                    `Error discovering tools from ${toPascalCase(serverConfig.name)}: ${errorDetails}`,
                  );

                  if (errorMessage.includes("timeout") || errorMessage.includes("Timeout") || errorString.includes("timeout") || errorString.includes("Timeout")) {
                    if (isAuthRequired) {
                      yield* terminal.warn(
                        `MCP server ${toPascalCase(serverConfig.name)} connection timed out after 30 seconds. The server may be waiting for authentication. Please check if manual authentication is required.`,
                      );
                    } else {
                      yield* terminal.warn(
                        `MCP server ${toPascalCase(serverConfig.name)} connection timed out after 30 seconds`,
                      );
                    }
                  } else if (isAuthRequired) {
                    yield* terminal.warn(
                      `MCP server ${toPascalCase(serverConfig.name)} requires authentication: ${errorMessage}`,
                    );
                  } else {
                    yield* terminal.warn(
                      `Failed to discover tools from MCP server ${toPascalCase(serverConfig.name)}: ${errorMessage}`,
                    );
                  }
                  // Return empty array on error/timeout
                  return [] as readonly MCPTool[];
                }),
              ),
            );

            if (mcpTools.length === 0) {
              yield* terminal.debug(`No tools discovered from ${serverConfig.name} - this could mean the server has no tools, or there was an error during discovery (check logs above)`);
              yield* logger.warn(`No tools discovered from ${serverConfig.name} - server may have no tools available or discovery failed silently`);
              return;
            }

            yield* terminal.debug(
              `Discovered ${mcpTools.length} tools from ${toPascalCase(serverConfig.name)}: ${mcpTools.map(t => t.name).slice(0, 5).join(", ")}${mcpTools.length > 5 ? "..." : ""}`,
            );

            // Determine category for tools using the exact display name from the UI
            const category = {
              id: `mcp_${serverConfig.name.toLowerCase()}`,
              displayName: categoryDisplayName,
            };

            // Register tools
            const registerTool = toolRegistry.registerForCategory(category);
            const jazzTools = yield* registerMCPServerTools(serverConfig, mcpTools);

            for (const tool of jazzTools) {
              yield* registerTool(tool);
            }

            yield* logger.info(
              `Registered ${jazzTools.length} tools from MCP server ${serverConfig.name} in category "${categoryDisplayName}"`,
            );
            yield* terminal.debug(
              `Registered ${jazzTools.length} tools from MCP server ${serverConfig.name}`,
            );
          }).pipe(
            Effect.catchAll(() =>
              Effect.gen(function* () {
                // If discovery/registration fails, continue without this server's tools
                yield* logger.warn(`Failed to discover/register tools from MCP server ${serverConfig.name}`);
                yield* terminal.debug(`Failed to discover/register tools from MCP server ${serverConfig.name}`);
              }),
            ),
          ),
        );

        // Run all discoveries in parallel
        yield* Effect.all(discoveryEffects, { concurrency: "unbounded" });

        // Refresh tools list after MCP discovery
        toolsByCategory = yield* toolRegistry.listToolsByCategory();
        yield* terminal.debug(
          `After MCP discovery, available categories: ${Object.keys(toolsByCategory).join(", ")}`,
        );
      }
    }

    // Prompt for updates
    const editAnswers = yield* Effect.promise(() =>
      promptForAgentUpdates(
        agent,
        providers,
        agentTypes,
        toolsByCategory,
        terminal,
        llmService,
        configService,
        currentProviderInfo,
        fieldToUpdate,
        mcpServerData,
      ),
    );

    // Tools are already discovered and registered (if fieldToUpdate was "tools")
    // Just convert selected categories to tool names
    // Convert selected categories (display names) to tool names
    // Only process if user selected tools (editAnswers.tools contains category display names)
    if (editAnswers.tools && editAnswers.tools.length > 0) {
      // Refresh toolsByCategory to ensure we have the latest tools (including newly registered MCP tools)
      toolsByCategory = yield* toolRegistry.listToolsByCategory();

      yield* logger.debug(
        `Available categories in toolsByCategory: ${Object.keys(toolsByCategory).join(", ")}`,
      );
      yield* terminal.debug(`Available categories in toolsByCategory: ${Object.keys(toolsByCategory).join(", ")}`);
      yield* logger.debug(
        `Selected category display names: ${editAnswers.tools.join(", ")}`,
      );
      yield* terminal.debug(`Selected category display names: ${editAnswers.tools.join(", ")}`);

      // Get tools directly from toolsByCategory using the selected display names
      // This ensures we get all tools from selected categories, including newly registered MCP tools
      // Use case-insensitive lookup to handle any capitalization mismatches
      const selectedToolNames: string[] = [];
      const categoryKeys = Object.keys(toolsByCategory);
      const categoryMap = new Map<string, string>();
      for (const key of categoryKeys) {
        categoryMap.set(key.toLowerCase(), key);
      }

      for (const selectedDisplayName of editAnswers.tools) {
        // Try exact match first
        let toolsInCategory = toolsByCategory[selectedDisplayName];

        // If not found, try case-insensitive match
        if (!toolsInCategory || toolsInCategory.length === 0) {
          const normalizedKey = categoryMap.get(selectedDisplayName.toLowerCase());
          if (normalizedKey) {
            toolsInCategory = toolsByCategory[normalizedKey];
            yield* logger.debug(
              `Found category "${normalizedKey}" using case-insensitive match for "${selectedDisplayName}"`,
            );
            yield* terminal.debug(`Found category "${normalizedKey}" using case-insensitive match for "${selectedDisplayName}"`);
          }
        }

        if (toolsInCategory && toolsInCategory.length > 0) {
          yield* logger.debug(
            `Found ${toolsInCategory.length} tools in category "${selectedDisplayName}": ${toolsInCategory.slice(0, 5).join(", ")}${toolsInCategory.length > 5 ? "..." : ""}`,
          );
          yield* terminal.debug(`Found ${toolsInCategory.length} tools in category "${selectedDisplayName}": ${toolsInCategory.slice(0, 5).join(", ")}${toolsInCategory.length > 5 ? "..." : ""}`);
          selectedToolNames.push(...toolsInCategory);
        } else {
          yield* logger.warn(
            `No tools found in category "${selectedDisplayName}". Available categories: ${categoryKeys.join(", ")}`,
          );
          yield* terminal.warn(
            `No tools found in category "${selectedDisplayName}". Available categories: ${categoryKeys.join(", ")}`,
          );
        }
      }

      const uniqueToolNames = Array.from(new Set(selectedToolNames));

      yield* logger.debug(
        `Total unique tool names from selected categories: ${uniqueToolNames.length} tools: ${uniqueToolNames.slice(0, 10).join(", ")}${uniqueToolNames.length > 10 ? "..." : ""}`,
      );
      yield* terminal.debug(`Total unique tool names from selected categories: ${uniqueToolNames.length} tools: ${uniqueToolNames.slice(0, 10).join(", ")}${uniqueToolNames.length > 10 ? "..." : ""}`);

      // Always update tools with the actual tool names (including newly registered MCP tools)
      editAnswers.tools = uniqueToolNames;
    }

    // Build updated configuration
    const updatedConfig: AgentConfig = {
      ...agent.config,
      ...(editAnswers.agentType && { agentType: editAnswers.agentType }),
      ...(editAnswers.llmProvider && { llmProvider: editAnswers.llmProvider }),
      ...(editAnswers.llmModel && { llmModel: editAnswers.llmModel }),
      ...(editAnswers.reasoningEffort && { reasoningEffort: editAnswers.reasoningEffort }),
      ...(editAnswers.tools &&
        editAnswers.tools.length > 0 && { tools: Array.from(new Set(editAnswers.tools)) }),
    };

    // Build update object
    const updates: Partial<Agent> = {
      ...(editAnswers.name && { name: editAnswers.name }),
      ...(editAnswers.description && { description: editAnswers.description }),
      config: updatedConfig,
    };

    // Update the agent
    const updatedAgent = yield* agentService.updateAgent(agent.id, updates);

    // Display success message
    yield* terminal.success("Agent updated successfully!");
    yield* terminal.log(`   ID: ${updatedAgent.id}`);
    yield* terminal.log(`   Name: ${updatedAgent.name}`);
    yield* terminal.log(`   Description: ${updatedAgent.description}`);
    yield* terminal.log(`   Type: ${updatedConfig.agentType || "N/A"}`);
    yield* terminal.log(`   LLM Provider: ${updatedConfig.llmProvider || "N/A"}`);
    yield* terminal.log(`   LLM Model: ${updatedConfig.llmModel || "N/A"}`);
    yield* terminal.log(`   Reasoning: ${updatedConfig.reasoningEffort || "N/A"}`);
    yield* terminal.log(`   Tools: ${updatedConfig.tools ? updatedConfig.tools.length : 0} tools`);
    yield* terminal.log(`   Updated: ${updatedAgent.updatedAt.toISOString()}`);
    yield* terminal.log("");
    yield* terminal.info("You can now chat with your updated agent using:");
    yield* terminal.log(`jazz agent chat ${updatedAgent.name}`);
  });
}

/**
 * Prompt for agent updates
 */
async function promptForAgentUpdates(
  currentAgent: Agent,
  providers: readonly { name: ProviderName; displayName?: string; configured: boolean }[],
  agentTypes: readonly string[],
  toolsByCategory: Record<string, readonly string[]>, // { displayName: string[] }
  terminal: TerminalService,
  llmService: LLMService,
  configService: AgentConfigService,
  currentProviderInfo: LLMProvider | null,
  fieldToUpdate: string,
  mcpServerData: { categories: Record<string, readonly string[]>; displayNameToServerName: Map<string, string> },
): Promise<AgentEditAnswers> {
  const answers: AgentEditAnswers = {};

  // Update name
  if (fieldToUpdate === "name") {
    const name = await Effect.runPromise(
      terminal.ask("Enter new agent name:", {
        defaultValue: currentAgent.name,
        validate: (inputValue: string) => {
          if (!inputValue.trim()) {
            return "Agent name cannot be empty";
          }
          if (inputValue.length > 100) {
            return "Agent name must be 100 characters or less";
          }
          return true;
        },
      }),
    );
    answers.name = name;
  }

  // Update description
  if (fieldToUpdate === "description") {
    const description = await Effect.runPromise(
      terminal.ask("Enter new agent description:", {
        defaultValue: currentAgent.description || "",
        validate: (inputValue: string) => {
          if (!inputValue.trim()) {
            return "Agent description cannot be empty";
          }
          if (inputValue.length > 500) {
            return "Agent description must be 500 characters or less";
          }
          return true;
        },
      }),
    );
    answers.description = description;
  }

  // Update agent type
  if (fieldToUpdate === "agentType") {
    const agentType = await Effect.runPromise(
      terminal.select<string>("Select agent type:", {
        choices: agentTypes.map((type) => ({ name: type, value: type })),
        ...(currentAgent.config.agentType || agentTypes[0]
          ? { default: currentAgent.config.agentType || agentTypes[0] }
          : {}),
      }),
    );

    if (!agentType) {
      throw new Error("Edit cancelled");
    }

    answers.agentType = agentType;
  }

  // Update LLM provider
  if (fieldToUpdate === "llmProvider") {
    const llmProvider = await Effect.runPromise(
      terminal.search<ProviderName>("Select LLM provider:", {
        choices: providers.map((provider) => ({
          name: provider.displayName ?? provider.name,
          value: provider.name,
        })),
      }),
    );

    if (!llmProvider) {
      throw new Error("Edit cancelled");
    }

    answers.llmProvider = llmProvider;
    const providerDisplayName =
      providers.find((p) => p.name === llmProvider)?.displayName ?? llmProvider;

    // Check if API key exists for the selected provider
    const apiKeyPath = `llm.${llmProvider}.api_key`;
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

      const apiKey = await Effect.runPromise(
        terminal.ask(`${providerDisplayName} API Key:`, {
          validate: (inputValue: string): boolean | string => {
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

    // When provider is changed, we must also select a model for that provider
    const providerInfo = await Effect.runPromise(llmService.getProvider(llmProvider)).catch(
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to get provider info: ${message}`);
      },
    );

    const llmModel = await Effect.runPromise(
      terminal.search<string>(`Select model for ${providerDisplayName}:`, {
        choices: providerInfo.supportedModels.map((model) => ({
          name: model.displayName || model.id,
          value: model.id,
        })),
      }),
    );

    if (!llmModel) {
      throw new Error("Edit cancelled");
    }

    answers.llmModel = llmModel;

    // Check if the selected model is a reasoning model
    const selectedModelInfo = providerInfo.supportedModels.find((model) => model.id === llmModel);
    const isReasoningModel = selectedModelInfo?.isReasoningModel ?? false;

    // If it's a reasoning model, ask for reasoning effort level
    if (isReasoningModel) {
      answers.reasoningEffort = await promptForReasoningEffort(terminal, currentAgent);
    }
  }

  // Update LLM model (only if provider wasn't already updated)
  if (fieldToUpdate === "llmModel" && !answers.llmProvider) {
    // Use current provider to get available models
    const providerToUse = currentAgent.config.llmProvider;
    const providerInfo =
      currentProviderInfo ||
      (await Effect.runPromise(llmService.getProvider(providerToUse)).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to get provider info: ${message}`);
      }));

    const llmModel = await Effect.runPromise(
      terminal.search<string>(`Select model for ${providerToUse}:`, {
        choices: providerInfo.supportedModels.map((model) => ({
          name: model.displayName || model.id,
          value: model.id,
        })),
      }),
    );

    if (!llmModel) {
      throw new Error("Edit cancelled");
    }

    answers.llmModel = llmModel;

    // Check if the selected model is a reasoning model
    const selectedModelInfo = providerInfo.supportedModels.find((model) => model.id === llmModel);
    const isReasoningModel = selectedModelInfo?.isReasoningModel ?? false;

    // If it's a reasoning model, ask for reasoning effort level
    if (isReasoningModel) {
      answers.reasoningEffort = await promptForReasoningEffort(terminal, currentAgent);
    }
  }

  // Update tools
  if (fieldToUpdate === "tools") {
    // Get current agent's tool names
    const currentToolNames = normalizeToolConfig(currentAgent.config.tools, {
      agentId: currentAgent.id,
    });
    const currentToolSet = new Set(currentToolNames);

    // Find which categories contain the agent's current tools
    const defaultCategories: string[] = [];
    for (const [categoryDisplayName, toolsInCategory] of Object.entries(toolsByCategory)) {
      // Check if any of the agent's current tools are in this category
      const hasAgentTool = toolsInCategory.some((toolName) => currentToolSet.has(toolName));
      if (hasAgentTool) {
        defaultCategories.push(categoryDisplayName);
      }
    }

    // Check for MCP tools and add corresponding MCP server categories
    const mcpToolNames = currentToolNames.filter((name) => name.startsWith("mcp_"));
    if (mcpToolNames.length > 0) {
      // Extract server names from MCP tool names
      const serverNamesResult = await Effect.runPromise(
        extractServerNamesFromToolNames(mcpToolNames).pipe(
          Effect.catchAll(() => Effect.succeed(new Set<string>())),
        ),
      );
      const serverNames = serverNamesResult;

      // Map server names to display names (reverse lookup)
      const serverNameToDisplayName = new Map<string, string>();
      for (const [displayName, serverName] of mcpServerData.displayNameToServerName.entries()) {
        serverNameToDisplayName.set(serverName.toLowerCase(), displayName);
      }

      // Add MCP server categories that the agent uses
      for (const serverName of serverNames) {
        const displayName = serverNameToDisplayName.get(serverName.toLowerCase());
        if (displayName && !defaultCategories.includes(displayName)) {
          defaultCategories.push(displayName);
        }
      }
    }



    const searchCategoryName = WEB_SEARCH_CATEGORY.displayName;
    let selectedCategories: readonly string[] = [...defaultCategories];

    // Loop for tool selection
    while (true) {
      selectedCategories = await Effect.runPromise(
        terminal.checkbox<string>("Select tool categories:", {
          choices: Object.keys(toolsByCategory).map((category) => ({
            name: `${category} ${toolsByCategory[category]?.length ? `(${toolsByCategory[category]?.length} tools)` : ""}`,
            value: category,
            selected: selectedCategories.includes(category),
          })),
          ...(selectedCategories.length > 0
            ? { default: selectedCategories }
            : {}),
        }),
      );

      // If Search is selected, verify configuration
      if (selectedCategories.includes(searchCategoryName)) {
        // Use current agent's provider since we are editing tools, not provider (unless provider was updated in same flow? No, fieldToUpdate is single selection)
        // Actually, if we allow multi-field edit later this assumption might break, but for now it's single field.
        const providerName = currentAgent.config.llmProvider;
        if (providerName) {
           const configured = await Effect.runPromise(
            handleWebSearchConfiguration(terminal, configService, llmService, providerName),
          );

          if (!configured) {
            // User wants to go back
            selectedCategories = selectedCategories.filter((c) => c !== searchCategoryName);
            await Effect.runPromise(terminal.log("")); // Spacing
            continue;
          }
        }
      }

      break;
    }

    // Store display names - will be converted to tool names in the calling function
    answers.tools = [...selectedCategories];
  }

  if (fieldToUpdate === "reasoningEffort") {
    answers.reasoningEffort = await promptForReasoningEffort(terminal, currentAgent);
  }

  return answers;
}



async function promptForReasoningEffort(
  terminal: TerminalService,
  currentAgent: Agent,
): Promise<"disable" | "low" | "medium" | "high"> {
  const result = await Effect.runPromise(
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
        default: currentAgent.config.reasoningEffort || "medium",
      },
    ),
  );

  if (!result) {
    throw new Error("Edit cancelled");
  }

  return result;
}
