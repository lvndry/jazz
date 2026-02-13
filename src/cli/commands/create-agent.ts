import { Effect } from "effect";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import React from "react";
import { handleWebSearchConfiguration } from "@/cli/helpers/web-search";
import { THEME } from "@/cli/ui/theme";
import { agentPromptBuilder } from "@/core/agent/agent-prompt";
import { registerMCPServerTools } from "@/core/agent/tools/mcp-tools";
import {
  createCategoryMappings,
  FILE_MANAGEMENT_CATEGORY,
  getMCPServerCategories,
  GIT_CATEGORY,
  HTTP_CATEGORY,
  SHELL_COMMANDS_CATEGORY,
  WEB_SEARCH_CATEGORY,
  BUILTIN_TOOL_CATEGORIES,
} from "@/core/agent/tools/register-tools";
import type { ProviderName } from "@/core/constants/models";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
import { AgentServiceTag, type AgentService } from "@/core/interfaces/agent-service";
import { LLMServiceTag, type LLMService } from "@/core/interfaces/llm";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import { MCPServerManagerTag, type MCPServerManager } from "@/core/interfaces/mcp-server";
import { ink, TerminalServiceTag, type TerminalService } from "@/core/interfaces/terminal";
import { ToolRegistryTag, type ToolRegistry } from "@/core/interfaces/tool-registry";
import {
  AgentAlreadyExistsError,
  AgentConfigurationError,
  LLMConfigurationError,
  StorageError,
  ValidationError,
} from "@/core/types/errors";
import type { AgentConfig } from "@/core/types/index";
import type { LLMProvider, LLMProviderListItem } from "@/core/types/llm";
import type { MCPTool } from "@/core/types/mcp";
import { isAuthenticationRequired } from "@/core/utils/mcp-utils";
import { formatProviderDisplayName, toPascalCase } from "@/core/utils/string";

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
  researcher: {
    id: "researcher",
    displayName: "Researcher",
    emoji: "🔬",
    toolCategoryIds: [WEB_SEARCH_CATEGORY.id, HTTP_CATEGORY.id, FILE_MANAGEMENT_CATEGORY.id],
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
  | AgentService
  | LLMService
  | ToolRegistry
  | TerminalService
  | AgentConfigService
  | MCPServerManager
  | LoggerService
> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    yield* terminal.heading("🤖 Welcome to the Jazz AI Agent Creation Wizard!");
    yield* terminal.log("Let's create a new AI agent step by step.");
    yield* terminal.log("");

    const llmService = yield* LLMServiceTag;
    const configService = yield* AgentConfigServiceTag;
    const toolRegistry = yield* ToolRegistryTag;

    const agentTypes = yield* agentPromptBuilder.listPersonas();
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
    const agentAnswers = yield* Effect.tryPromise({
      try: () =>
        promptForAgentInfo(
          agentTypes,
          toolsByCategory,
          llmService,
          configService,
          categoryIdToDisplayName,
          terminal,
        ),
      catch: (error) =>
        new ValidationError({
          field: "agent",
          message: `Agent creation wizard failed: ${error instanceof Error ? error.message : String(error)}`,
        }),
    });

    // User cancelled agent creation (ESC on first step)
    if (agentAnswers === null) {
      return;
    }

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

      // Show spinner while discovering MCP tools
      yield* terminal.log(
        ink(
          React.createElement(
            Box,
            {},
            React.createElement(
              Text,
              { color: THEME.primary },
              React.createElement(Spinner, { type: "dots" }),
            ),
            React.createElement(Text, {}, " Discovering tools from MCP servers..."),
          ),
        ),
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
                const errorMessage = error instanceof Error ? error.message : String(error);
                const isAuthRequired = isAuthenticationRequired(error);

                if (errorMessage.includes("timeout") || errorMessage.includes("Timeout")) {
                  if (isAuthRequired) {
                    yield* logger.warn(
                      `MCP server ${toPascalCase(serverConfig.name)} connection timed out after 45 seconds. The server may be waiting for authentication. Please check if manual authentication is required.`,
                    );
                  } else {
                    yield* logger.warn(
                      `MCP server ${toPascalCase(serverConfig.name)} connection timed out after 45 seconds`,
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
    yield* terminal.log(`   LLM Provider: ${formatProviderDisplayName(config.llmProvider)}`);
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
 * Wizard step identifiers for agent creation flow
 */
type WizardStep =
  | "provider"
  | "model"
  | "reasoning"
  | "agentType"
  | "name"
  | "description"
  | "tools"
  | "done";

/**
 * State machine for agent creation wizard
 */
interface WizardState {
  step: WizardStep;
  // Collected answers (preserved when going back)
  llmProvider?: ProviderName;
  llmModel?: string;
  reasoningEffort?: "disable" | "low" | "medium" | "high";
  agentType?: string;
  name?: string;
  description?: string;
  tools?: string[];
  // Cached data
  allProviders?: readonly LLMProviderListItem[];
  providerInfo?: LLMProvider;
  isReasoningModel?: boolean;
  supportsTools?: boolean;
}

/**
 * Prompt for basic agent information with ESC-based back navigation.
 *
 * Each step allows pressing ESC to go back to the previous step.
 * State is preserved when navigating backward.
 */
async function promptForAgentInfo(
  agentTypes: readonly string[],
  toolsByCategory: Record<string, readonly string[]>,
  llmService: LLMService,
  configService: AgentConfigService,
  categoryIdToDisplayName: Map<string, string>,
  terminal: TerminalService,
): Promise<AIAgentCreationAnswers | null> {
  // Initialize state machine
  const state: WizardState = { step: "provider" };
  state.allProviders = await Effect.runPromise(llmService.listProviders());

  // Show navigation hint
  await Effect.runPromise(
    terminal.info("💡 Tip: Press ESC at any step to go back to the previous choice."),
  );

  const hint = "(ESC to go back)";

  while (state.step !== "done") {
    switch (state.step) {
      // ═══════════════════════════════════════════════════════════════════════
      // STEP 1: Provider Selection
      // ═══════════════════════════════════════════════════════════════════════
      case "provider": {
        const result = await Effect.runPromise(
          terminal.search<ProviderName>("Which LLM provider would you like to use?", {
            choices: state.allProviders.map((provider) => ({
              name: provider.displayName ?? provider.name,
              value: provider.name,
            })),
          }),
        );

        if (result === undefined) {
          // ESC pressed on first step - return null to indicate cancellation
          return null;
        }

        state.llmProvider = result;

        // Check/prompt for API key
        const providerDisplayName =
          state.allProviders.find((p) => p.name === result)?.displayName ?? result;
        const apiKeyPath = `llm.${result}.api_key`;
        const hasApiKey = await Effect.runPromise(configService.has(apiKeyPath));

        if (!hasApiKey) {
          await Effect.runPromise(
            Effect.gen(function* () {
              yield* terminal.log("");
              yield* terminal.warn(`API key not set in config file for ${providerDisplayName}.`);
              yield* terminal.log("Please paste your API key below:");
            }),
          );

          const isOptional = result === "ollama";
          const apiKey = await Effect.runPromise(
            terminal.ask(`${providerDisplayName} API Key${isOptional ? " (optional)" : ""}:`, {
              validate: (inputValue: string): boolean | string => {
                if (isOptional) return true;
                if (!inputValue || inputValue.trim().length === 0) {
                  return "API key cannot be empty";
                }
                return true;
              },
            }),
          );

          await Effect.runPromise(configService.set(apiKeyPath, apiKey));
          await Effect.runPromise(
            Effect.gen(function* () {
              yield* terminal.success("API key saved to config file.");
              yield* terminal.log("");
            }),
          );
        }

        // Cache provider info for next step
        state.providerInfo = await Effect.runPromise(llmService.getProvider(result)).catch(
          (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to get provider info: ${message}`);
          },
        );

        state.step = "model";
        break;
      }

      // ═══════════════════════════════════════════════════════════════════════
      // STEP 2: Model Selection
      // ═══════════════════════════════════════════════════════════════════════
      case "model": {
        const result = await Effect.runPromise(
          terminal.search<string>(`Which model would you like to use? ${hint}`, {
            choices: state.providerInfo!.supportedModels.map((model) => ({
              name: model.displayName || model.id,
              description: model.displayName || model.id,
              value: model.id,
            })),
          }),
        );

        if (result === undefined) {
          state.step = "provider";
          break;
        }

        state.llmModel = result;

        // Check if reasoning model
        const selectedModel = state.providerInfo!.supportedModels.find((m) => m.id === result);
        state.isReasoningModel = selectedModel?.isReasoningModel ?? false;
        state.supportsTools = selectedModel?.supportsTools ?? false;

        state.step = state.isReasoningModel ? "reasoning" : "agentType";
        break;
      }

      // ═══════════════════════════════════════════════════════════════════════
      // STEP 3: Reasoning Effort (optional, only for reasoning models)
      // ═══════════════════════════════════════════════════════════════════════
      case "reasoning": {
        const result = await Effect.runPromise(
          terminal.select<"disable" | "low" | "medium" | "high">(
            `What reasoning effort level would you like? ${hint}`,
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
              default: state.reasoningEffort ?? "medium",
            },
          ),
        );

        if (result === undefined) {
          state.step = "model";
          break;
        }

        state.reasoningEffort = result;
        state.step = "agentType";
        break;
      }

      // ═══════════════════════════════════════════════════════════════════════
      // STEP 4: Agent Type
      // ═══════════════════════════════════════════════════════════════════════
      case "agentType": {
        const result = await Effect.runPromise(
          terminal.select<string>(`What persona should the agent have? ${hint}`, {
            choices: agentTypes,
            default: state.agentType ?? "default",
          }),
        );

        if (result === undefined) {
          state.step = state.isReasoningModel ? "reasoning" : "model";
          break;
        }

        state.agentType = result;
        state.step = "name";
        break;
      }

      // ═══════════════════════════════════════════════════════════════════════
      // STEP 5: Agent Name
      // ═══════════════════════════════════════════════════════════════════════
      case "name": {
        const askOptions: {
          defaultValue?: string;
          validate: (inputValue: string) => boolean | string;
          cancellable: boolean;
          simple: boolean;
        } = {
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
          cancellable: true,
          simple: true,
        };
        if (state.name) {
          askOptions.defaultValue = state.name;
        }

        const result = await Effect.runPromise(
          terminal.ask(`Name of your new agent ${hint}:`, askOptions),
        );

        // ESC pressed - go back
        if (result === undefined) {
          state.step = "agentType";
          break;
        }

        state.name = result;
        state.step = state.agentType === "default" ? "description" : "tools";
        break;
      }

      // ═══════════════════════════════════════════════════════════════════════
      // STEP 6: Description (only for default agent type)
      // ═══════════════════════════════════════════════════════════════════════
      case "description": {
        const descOptions: {
          defaultValue?: string;
          validate: (inputValue: string) => boolean | string;
          cancellable: boolean;
          simple: boolean;
        } = {
          validate: (inputValue: string): boolean | string => {
            if (!inputValue || inputValue.trim().length === 0) {
              return "Agent description cannot be empty";
            }
            if (inputValue.length > 500) {
              return "Agent description cannot exceed 500 characters";
            }
            return true;
          },
          cancellable: true,
          simple: true,
        };
        if (state.description) {
          descOptions.defaultValue = state.description;
        }

        const result = await Effect.runPromise(
          terminal.ask(`Describe what this agent will do ${hint}:`, descOptions),
        );

        // ESC pressed - go back
        if (result === undefined) {
          state.step = "name";
          break;
        }

        state.description = result;
        state.step = "tools";
        break;
      }

      // ═══════════════════════════════════════════════════════════════════════
      // STEP 7: Tool Selection
      // ═══════════════════════════════════════════════════════════════════════
      case "tools": {
        const currentPredefinedAgent = PREDEFINED_AGENTS[state.agentType!];

        if (!state.supportsTools) {
          // Model doesn't support tools - show warning and proceed
          if (currentPredefinedAgent && currentPredefinedAgent.toolCategoryIds.length > 0) {
            await Effect.runPromise(
              terminal.warn(
                `\n⚠️  The selected model (${state.llmModel}) does not support tools. The "${currentPredefinedAgent.displayName}" agent's preconfigured tools will be ignored.`,
              ),
            );
          } else {
            await Effect.runPromise(
              terminal.info(
                `\nℹ️  Skipping tool selection as the selected model (${state.llmModel}) does not support tools.`,
              ),
            );
          }
          state.tools = [];
          state.step = "done";
          break;
        }

        if (currentPredefinedAgent) {
          // Predefined agent - show what tools will be included
          const availableCategoryIds = currentPredefinedAgent.toolCategoryIds.filter(
            (categoryId) => {
              const displayName = categoryIdToDisplayName.get(categoryId);
              return displayName && displayName in toolsByCategory;
            },
          );

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

          state.tools = displayNames;
          state.step = "done";
          break;
        }

        // Custom agent - let user select tools
        const defaultToolCategories = [
          FILE_MANAGEMENT_CATEGORY.displayName,
          HTTP_CATEGORY.displayName,
          GIT_CATEGORY.displayName,
          WEB_SEARCH_CATEGORY.displayName,
          SHELL_COMMANDS_CATEGORY.displayName,
        ];
        let selectedTools: readonly string[] = state.tools?.length
          ? state.tools
          : defaultToolCategories.filter((name) => name in toolsByCategory);

        // Loop for tool selection to allow "Go Back" from web search config
        let shouldGoBack = false;
        while (true) {
          selectedTools = await Effect.runPromise(
            terminal.checkbox<string>(`Which tools should this agent have access to? ${hint}`, {
              choices: Object.entries(toolsByCategory)
                .filter(
                  ([category]) => !BUILTIN_TOOL_CATEGORIES.some((c) => c.displayName === category),
                )
                .map(([category, toolsInCategory]) => ({
                  name:
                    toolsInCategory.length > 0
                      ? `${category} (${toolsInCategory.length} ${toolsInCategory.length === 1 ? "tool" : "tools"})`
                      : category,
                  value: category,
                })),
              default: [...selectedTools],
            }),
          );

          // Handle empty selection as potential back navigation
          if (selectedTools.length === 0) {
            // Ask if they want to go back or proceed with no tools
            const confirm = await Effect.runPromise(
              terminal.confirm("No tools selected. Go back to previous step?", true),
            );
            if (confirm) {
              shouldGoBack = true;
              break;
            }
          }

          if (selectedTools.includes(WEB_SEARCH_CATEGORY.displayName)) {
            const configured = await Effect.runPromise(
              handleWebSearchConfiguration(terminal, configService, llmService, state.llmProvider!),
            );

            if (!configured) {
              await Effect.runPromise(terminal.log(""));
              continue;
            }
          }

          state.tools = [...selectedTools];
          break;
        }

        if (shouldGoBack) {
          state.step = state.agentType === "default" ? "description" : "name";
          break;
        }

        state.step = "done";
        break;
      }
    }
  }

  // Build final answer object
  const currentPredefinedAgent = PREDEFINED_AGENTS[state.agentType!];
  const finalTools = state.supportsTools
    ? currentPredefinedAgent
      ? currentPredefinedAgent.toolCategoryIds
          .map((id) => categoryIdToDisplayName.get(id))
          .filter((name): name is string => name !== undefined && name in toolsByCategory)
      : (state.tools ?? [])
    : [];

  return {
    llmProvider: state.llmProvider!,
    llmModel: state.llmModel!,
    ...(state.reasoningEffort && { reasoningEffort: state.reasoningEffort }),
    agentType: state.agentType!,
    name: state.name!,
    ...(state.description && { description: state.description }),
    tools: finalTools,
  };
}
