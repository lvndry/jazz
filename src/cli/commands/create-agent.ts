import { Effect } from "effect";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import React from "react";
import { ensureProviderApiKey } from "@/cli/helpers/provider-api-key";
import { handleWebSearchConfiguration } from "@/cli/helpers/web-search";
import { THEME } from "@/cli/ui/theme";
import { registerMCPServerTools } from "@/core/agent/tools/mcp-tools";
import { getMCPServerCategories } from "@/core/agent/tools/register-mcp-tools";
import {
  BUILTIN_TOOL_CATEGORIES,
  createCategoryMappings,
  FILE_MANAGEMENT_CATEGORY,
  HTTP_CATEGORY,
  mcpToolCategory,
  SHELL_COMMANDS_CATEGORY,
  WEB_SEARCH_CATEGORY,
} from "@/core/agent/tools/tool-categories";
import type { ProviderName } from "@/core/constants/models";
import {
  buildOllamaContextChoices,
  defaultOllamaContextWindow,
  isOllamaCloudModel,
} from "@/core/constants/ollama";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
import { AgentServiceTag, type AgentService } from "@/core/interfaces/agent-service";
import { LLMServiceTag, type LLMService } from "@/core/interfaces/llm";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import { MCPServerManagerTag, type MCPServerManager } from "@/core/interfaces/mcp-server";
import { PersonaServiceTag, type PersonaService } from "@/core/interfaces/persona-service";
import { ink, TerminalServiceTag, type TerminalService } from "@/core/interfaces/terminal";
import { ToolRegistryTag, type ToolRegistry } from "@/core/interfaces/tool-registry";
import type { WebSearchProviderName } from "@/core/types/config";
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
import { isAuthenticationRequired } from "@/core/utils/mcp";
import { formatProviderDisplayName } from "@/core/utils/provider-model";
import { buildModelChoices, sortProvidersForPicker } from "@/core/utils/provider-picker";
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
      HTTP_CATEGORY.id,
      WEB_SEARCH_CATEGORY.id,
    ],
  },
  researcher: {
    id: "researcher",
    displayName: "Researcher",
    emoji: "🔬",
    toolCategoryIds: [
      WEB_SEARCH_CATEGORY.id,
      HTTP_CATEGORY.id,
      FILE_MANAGEMENT_CATEGORY.id,
      SHELL_COMMANDS_CATEGORY.id,
    ],
  },
} as const;

interface AIAgentCreationAnswers {
  name: string;
  description?: string;
  persona: string;
  llmProvider: ProviderName;
  llmModel: string;
  reasoningEffort?: "disable" | "low" | "medium" | "high";
  numCtx?: number;
  tools: string[];
  webSearchProvider?: WebSearchProviderName;
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
  | PersonaService
> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    yield* terminal.heading("🤖 Welcome to the Jazz AI Agent Creation Wizard!");
    yield* terminal.log("Let's create a new AI agent step by step.");
    yield* terminal.log("");

    const llmService = yield* LLMServiceTag;
    const configService = yield* AgentConfigServiceTag;
    const toolRegistry = yield* ToolRegistryTag;

    const personaService = yield* PersonaServiceTag;
    const allPersonas = yield* personaService.listPersonas();
    const personaNames = allPersonas.map((p) => p.name);
    let toolsByCategory = yield* toolRegistry.listToolsByCategory();

    const mcpServerData = yield* getMCPServerCategories();
    toolsByCategory = { ...toolsByCategory, ...mcpServerData.categories };

    const categoryMappings = createCategoryMappings();
    const categoryDisplayNameToId: Map<string, string> = categoryMappings.displayNameToId;
    const categoryIdToDisplayName: Map<string, string> = categoryMappings.idToDisplayName;

    // Add MCP server category mappings (category ID format: mcp_<servername>)
    for (const [displayName, serverName] of mcpServerData.displayNameToServerName.entries()) {
      categoryDisplayNameToId.set(displayName, mcpToolCategory(serverName).id);
    }

    // Get agent basic information
    const agentAnswers = yield* Effect.tryPromise({
      try: () =>
        promptForAgentInfo(
          personaNames,
          toolsByCategory,
          llmService,
          configService,
          categoryIdToDisplayName,
          terminal,
          new Set(mcpServerData.displayNameToServerName.keys()),
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
      const selectedServerNames = selectedMCPDisplayNames.map((displayName) =>
        mcpServerData.displayNameToServerName.get(displayName)!,
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
      persona: agentAnswers.persona,
      llmProvider: agentAnswers.llmProvider,
      llmModel: selectedModel,
      ...(agentAnswers.reasoningEffort && { reasoningEffort: agentAnswers.reasoningEffort }),
      ...(typeof agentAnswers.numCtx === "number" && { numCtx: agentAnswers.numCtx }),
      ...(uniqueToolNames.length > 0 && { tools: uniqueToolNames }),
      ...(agentAnswers.webSearchProvider && { webSearchProvider: agentAnswers.webSearchProvider }),
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
    yield* terminal.log(`   Persona: ${config.persona}`);
    yield* terminal.log(`   LLM Provider: ${formatProviderDisplayName(config.llmProvider)}`);
    yield* terminal.log(`   LLM Model: ${config.llmModel}`);
    yield* terminal.log(`   Reasoning: ${config.reasoningEffort}`);
    if (typeof config.numCtx === "number") {
      yield* terminal.log(`   Context Window: ${config.numCtx.toLocaleString()} tokens`);
    }
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
  | "ollamaContext"
  | "persona"
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
  numCtx?: number;
  detectedContextWindow?: number;
  persona?: string;
  name?: string;
  description?: string;
  tools?: string[];
  webSearchProvider?: WebSearchProviderName;
  // Cached data
  allProviders?: readonly LLMProviderListItem[];
  providerInfo?: LLMProvider;
  isReasoningModel?: boolean;
  supportsTools?: boolean;
}

/** After model/reasoning, Ollama agents pick a context window before the persona. */
function stepAfterReasoning(state: WizardState): WizardStep {
  return state.llmProvider === "ollama" ? "ollamaContext" : "persona";
}

/** Where the persona step goes when the user presses ESC to go back. */
function personaBackStep(state: WizardState): WizardStep {
  if (state.llmProvider === "ollama") return "ollamaContext";
  return state.isReasoningModel ? "reasoning" : "model";
}

/**
 * Prompt for basic agent information with ESC-based back navigation.
 *
 * Each step allows pressing ESC to go back to the previous step.
 * State is preserved when navigating backward.
 */
async function promptForAgentInfo(
  personaNames: readonly string[],
  toolsByCategory: Record<string, readonly string[]>,
  llmService: LLMService,
  configService: AgentConfigService,
  categoryIdToDisplayName: Map<string, string>,
  terminal: TerminalService,
  mcpCategoryDisplayNames: ReadonlySet<string>,
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
            choices: sortProvidersForPicker(
              state.allProviders,
              (provider) => provider.name,
              (provider) => provider.displayName,
            ).map((provider) => ({
              name: provider.displayName ?? provider.name,
              value: provider.name,
            })),
            placeholder: "Search providers...",
          }),
        );

        if (result === undefined) {
          // ESC pressed on first step - return null to indicate cancellation
          return null;
        }

        state.llmProvider = result;

        const providerDisplayName =
          state.allProviders.find((p) => p.name === result)?.displayName ?? result;
        const keyResult = await ensureProviderApiKey({
          configService,
          terminal,
          provider: result,
          displayName: providerDisplayName,
          required: result !== "ollama" && result !== "llamacpp",
        });
        if (keyResult === "cancelled") {
          await Effect.runPromise(terminal.info("Cancelled — pick another provider."));
          break;
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
            choices: buildModelChoices(state.llmProvider!, state.providerInfo!.supportedModels),
            placeholder: "Search models...",
          }),
        );

        if (result === undefined) {
          state.step = "provider";
          break;
        }

        state.llmModel = result;

        if (state.llmProvider === "ollama" && isOllamaCloudModel(result)) {
          const providerDisplayName =
            state.allProviders?.find((p) => p.name === "ollama")?.displayName ?? "Ollama";
          const keyResult = await ensureProviderApiKey({
            configService,
            terminal,
            provider: "ollama",
            displayName: providerDisplayName,
            required: true,
            reason:
              "This is an Ollama Cloud model. Requests go to ollama.com and need an API key from https://ollama.com/settings/keys.",
          });
          if (keyResult === "cancelled") {
            state.step = "model";
            break;
          }
        }

        // Check if reasoning model
        const selectedModel = state.providerInfo!.supportedModels.find((m) => m.id === result);
        state.isReasoningModel = selectedModel?.isReasoningModel ?? false;
        state.supportsTools = selectedModel?.supportsTools ?? false;
        if (typeof selectedModel?.contextWindow === "number") {
          state.detectedContextWindow = selectedModel.contextWindow;
        }

        state.step = state.isReasoningModel ? "reasoning" : stepAfterReasoning(state);
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
        state.step = stepAfterReasoning(state);
        break;
      }

      // ═══════════════════════════════════════════════════════════════════════
      // STEP 3b: Ollama context window (only for Ollama agents)
      // ═══════════════════════════════════════════════════════════════════════
      case "ollamaContext": {
        const choices = buildOllamaContextChoices(state.detectedContextWindow);
        const result = await Effect.runPromise(
          terminal.select<number>(`What context window should this agent use? ${hint}`, {
            choices,
            default: state.numCtx ?? defaultOllamaContextWindow(state.detectedContextWindow),
          }),
        );

        if (result === undefined) {
          state.step = state.isReasoningModel ? "reasoning" : "model";
          break;
        }

        state.numCtx = result;
        state.step = "persona";
        break;
      }

      // ═══════════════════════════════════════════════════════════════════════
      // STEP 4: Persona Selection
      // ═══════════════════════════════════════════════════════════════════════
      case "persona": {
        const result = await Effect.runPromise(
          terminal.select<string>(`What persona should the agent have? ${hint}`, {
            choices: personaNames,
            default: state.persona ?? "default",
          }),
        );

        if (result === undefined) {
          state.step = personaBackStep(state);
          break;
        }

        state.persona = result;
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
          terminal.ask(`Name of your new agent ${hint}:`, {
            ...askOptions,
            placeholder: "my-agent",
          }),
        );

        // ESC pressed - go back
        if (result === undefined) {
          state.step = "persona";
          break;
        }

        state.name = result;
        state.step = state.persona === "default" ? "description" : "tools";
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
          terminal.ask(`Describe what this agent will do ${hint}:`, {
            ...descOptions,
            placeholder: "(optional, press Enter to skip)",
          }),
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
        const currentPredefinedAgent = PREDEFINED_AGENTS[state.persona!];

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
        const selectableCategories = Object.entries(toolsByCategory).filter(
          ([category]) => !BUILTIN_TOOL_CATEGORIES.some((c) => c.displayName === category),
        );

        // Opt-out rather than opt-in: every builtin category starts checked so
        // the user only unticks what they don't want. MCP servers stay opt-in —
        // checking one connects to that server (auth prompts, 45s timeouts).
        const defaultToolCategories = selectableCategories
          .map(([category]) => category)
          .filter((category) => !mcpCategoryDisplayNames.has(category));

        let selectedTools: readonly string[] = state.tools?.length
          ? state.tools
          : defaultToolCategories;

        // Loop for tool selection to allow "Go Back" from web search config
        let shouldGoBack = false;
        while (true) {
          selectedTools = await Effect.runPromise(
            terminal.checkbox<string>(`Which tools should this agent have access to? ${hint}`, {
              choices: selectableCategories.map(([category, toolsInCategory]) => ({
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

          let resolvedTools = [...selectedTools];

          if (selectedTools.includes(WEB_SEARCH_CATEGORY.displayName)) {
            const webSearchProvider = await Effect.runPromise(
              handleWebSearchConfiguration(terminal, configService, llmService, state.llmProvider!),
            );

            if (webSearchProvider === false) {
              await Effect.runPromise(terminal.log(""));
              continue;
            }

            if (webSearchProvider === "builtin") {
              resolvedTools = resolvedTools.filter((t) => t !== WEB_SEARCH_CATEGORY.displayName);
            } else {
              state.webSearchProvider = webSearchProvider;
            }
          }

          state.tools = resolvedTools;
          break;
        }

        if (shouldGoBack) {
          state.step = state.persona === "default" ? "description" : "name";
          break;
        }

        state.step = "done";
        break;
      }
    }
  }

  // Build final answer object
  const currentPredefinedAgent = PREDEFINED_AGENTS[state.persona!];
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
    ...(typeof state.numCtx === "number" && { numCtx: state.numCtx }),
    persona: state.persona!,
    name: state.name!,
    ...(state.description && { description: state.description }),
    tools: finalTools,
    ...(state.webSearchProvider && { webSearchProvider: state.webSearchProvider }),
  };
}
