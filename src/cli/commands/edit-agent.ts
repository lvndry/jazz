import { Effect } from "effect";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import React from "react";
import { ensureProviderApiKey } from "@/cli/helpers/provider-api-key";
import { handleWebSearchConfiguration } from "@/cli/helpers/web-search";
import { THEME } from "@/cli/ui/theme";
import * as fmt from "@/cli/utils/list-format";
import { getAgentByIdentifier } from "@/core/agent/agent-service";
import { registerMCPServerTools } from "@/core/agent/tools/mcp-tools";
import { getMCPServerCategories } from "@/core/agent/tools/register-mcp-tools";
import {
  createCategoryMappings,
  mcpToolCategory,
  SKILLS_CATEGORY,
  USER_INTERACTION_CATEGORY,
  WEB_SEARCH_CATEGORY,
} from "@/core/agent/tools/tool-categories";
import { normalizeToolConfig } from "@/core/agent/utils/tool-config";
import type { ProviderName } from "@/core/constants/models";
import { AVAILABLE_PROVIDERS } from "@/core/constants/models";
import {
  buildOllamaContextChoices,
  defaultOllamaContextWindow,
  isOllamaCloudModel,
} from "@/core/constants/ollama";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
import { AgentServiceTag, type AgentService } from "@/core/interfaces/agent-service";
import { LLMServiceTag, type LLMService } from "@/core/interfaces/llm";
import type { LoggerService } from "@/core/interfaces/logger";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import type { MCPServerManager } from "@/core/interfaces/mcp-server";
import { MCPServerManagerTag } from "@/core/interfaces/mcp-server";
import { PersonaServiceTag, type PersonaService } from "@/core/interfaces/persona-service";
import { ink, TerminalServiceTag, type TerminalService } from "@/core/interfaces/terminal";
import { ToolRegistryTag, type ToolRegistry } from "@/core/interfaces/tool-registry";
import type { Agent, AgentConfig, LLMProvider } from "@/core/types";
import type { WebSearchProviderName } from "@/core/types/config";
import {
  AgentAlreadyExistsError,
  AgentConfigurationError,
  LLMConfigurationError,
  StorageError,
  StorageNotFoundError,
  ValidationError,
} from "@/core/types/errors";
import type { MCPTool } from "@/core/types/mcp";
import { extractServerNamesFromToolNames, isAuthenticationRequired } from "@/core/utils/mcp";
import { getModelsDevMetadata } from "@/core/utils/models-dev";
import { formatProviderDisplayName } from "@/core/utils/provider-model";
import { sortProvidersForPicker } from "@/core/utils/provider-picker";
import { toPascalCase } from "@/core/utils/string";
import { isEditAgentMenuExit, shouldReturnToEditAgentMenu } from "./edit-agent-navigation";

/**
 * CLI commands for editing existing agents
 */

interface AgentEditAnswers {
  name?: string;
  description?: string;
  persona?: string;
  llmProvider?: ProviderName;
  llmModel?: string;
  llmApiKeyProvider?: ProviderName;
  llmApiKeyValue?: string;
  reasoningEffort?: "disable" | "low" | "medium" | "high";
  numCtx?: number;
  /** New ceiling in tokens, or null to remove the ceiling. */
  maxContextTokens?: number | null;
  tools?: string[];
  webSearchProvider?: WebSearchProviderName;
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
  | AgentService
  | PersonaService
  | LLMService
  | ToolRegistry
  | TerminalService
  | AgentConfigService
  | MCPServerManager
  | LoggerService
> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const agentService = yield* AgentServiceTag;
    let agent = yield* getAgentByIdentifier(agentIdentifier);

    while (true) {
      const formatDate = (date: Date): string =>
        date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });

      const summaryRows: string[] = [
        fmt.heading(`Edit agent · ${agent.name}`),
        "",
        ...(agent.description && agent.description !== agent.name
          ? [fmt.keyValueCompact("Description", agent.description)]
          : []),
        fmt.keyValueCompact(
          "Model",
          `${formatProviderDisplayName(agent.config.llmProvider)} · ${agent.config.llmModel}`,
        ),
        fmt.keyValueCompact("Persona", agent.config.persona || "default"),
        fmt.keyValueCompact("Reasoning", agent.config.reasoningEffort || "disabled"),
        fmt.keyValueCompact("Tools", `${agent.config.tools ? agent.config.tools.length : 0}`),
        fmt.keyValueCompact(
          "Updated",
          `${formatDate(agent.updatedAt)} (created ${formatDate(agent.createdAt)})`,
        ),
        fmt.keyValueCompact("ID", agent.id),
      ];
      yield* terminal.log(summaryRows.join("\n"));
      yield* terminal.log("");

      // Get available LLM providers and models
      const llmService = yield* LLMServiceTag;
      const configService = yield* AgentConfigServiceTag;
      const providers = yield* llmService.listProviders();

      // Get available personas (built-in + custom)
      const personaService = yield* PersonaServiceTag;
      const personas = yield* personaService.listPersonas();
      const personaNames = personas.map((p) => p.name);

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
        categoryDisplayNameToId.set(displayName, mcpToolCategory(serverName).id);
      }

      // Get current provider info for model selection
      const currentProviderInfo = yield* llmService
        .getProvider(agent.config.llmProvider)
        .pipe(Effect.catchAll(() => Effect.succeed(null as LLMProvider | null)));

      // Check if current model is reasoning model (needed for field choices)
      // Use models.dev metadata directly for more accuracy (especially for newer models)
      const currentModelMeta = yield* Effect.promise(() =>
        getModelsDevMetadata(agent.config.llmModel, agent.config.llmProvider),
      );
      const currentModelIsReasoning = currentModelMeta?.isReasoningModel ?? false;
      const supportsTools = currentModelMeta?.supportsTools ?? true; // Default to true if unknown to avoid blocking tools

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
          { name: "Persona", value: "persona" },
          { name: "LLM Provider", value: "llmProvider" },
          { name: "LLM Model", value: "llmModel" },
          { name: "LLM API Key (Agent Override)", value: "llmApiKey" },
          {
            name: currentModelIsReasoning
              ? "Reasoning Effort"
              : "Reasoning Effort (Not supported by current model)",
            value: "reasoningEffort",
            disabled: !currentModelIsReasoning,
          },
          {
            name: supportsTools ? "Tools" : "Tools (Not supported by current model)",
            value: "tools",
            disabled: !supportsTools,
          },
          ...(agent.config.llmProvider === "ollama"
            ? [{ name: "Context Window", value: "contextWindow" }]
            : []),
          { name: "Max Context Tokens", value: "maxContextTokens" },
          { name: "Done", value: "done" },
        ],
      });

      if (isEditAgentMenuExit(fieldToUpdate)) {
        return;
      }

      // Get logger and MCP manager for use throughout
      const logger = yield* LoggerServiceTag;
      const mcpManager = yield* MCPServerManagerTag;

      // If user selected "tools", connect to all configured MCP servers and discover their tools
      // BEFORE showing the tool selection, so all MCP tools are available
      if (fieldToUpdate === "tools") {
        if (!supportsTools) {
          yield* terminal.warn(
            `\n⚠️  The current model (${agent.config.llmModel}) does not support tools.`,
          );
          continue;
        }

        const allServers = yield* mcpManager.listServers();
        const enabledServers = allServers.filter((server) => server.enabled !== false);

        if (enabledServers.length > 0) {
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

          // Discover and register tools from all enabled MCP servers
          const discoveryEffects = enabledServers.map((serverConfig) =>
            Effect.gen(function* () {
              yield* logger.debug(`Discovering tools from MCP server ${serverConfig.name}...`);
              yield* terminal.debug(`Discovering tools from MCP server ${serverConfig.name}...`);

              // Find the display name for this server
              let categoryDisplayName: string | undefined;
              for (const [
                displayName,
                serverName,
              ] of mcpServerData.displayNameToServerName.entries()) {
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
                    const errorMessage = error instanceof Error ? error.message : String(error);
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

                    if (
                      errorMessage.includes("timeout") ||
                      errorMessage.includes("Timeout") ||
                      errorString.includes("timeout") ||
                      errorString.includes("Timeout")
                    ) {
                      if (isAuthRequired) {
                        yield* terminal.warn(
                          `MCP server ${toPascalCase(serverConfig.name)} connection timed out after 45 seconds. The server may be waiting for authentication. Please check if manual authentication is required.`,
                        );
                      } else {
                        yield* terminal.warn(
                          `MCP server ${toPascalCase(serverConfig.name)} connection timed out after 45 seconds`,
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
                yield* terminal.debug(
                  `No tools discovered from ${serverConfig.name} - this could mean the server has no tools, or there was an error during discovery (check logs above)`,
                );
                yield* logger.warn(
                  `No tools discovered from ${serverConfig.name} - server may have no tools available or discovery failed silently`,
                );
                return;
              }

              yield* terminal.debug(
                `Discovered ${mcpTools.length} tools from ${toPascalCase(serverConfig.name)}: ${mcpTools
                  .map((t) => t.name)
                  .slice(0, 5)
                  .join(", ")}${mcpTools.length > 5 ? "..." : ""}`,
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
                  yield* logger.warn(
                    `Failed to discover/register tools from MCP server ${serverConfig.name}`,
                  );
                  yield* terminal.debug(
                    `Failed to discover/register tools from MCP server ${serverConfig.name}`,
                  );
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

      const editAnswers = yield* Effect.tryPromise({
        try: () =>
          promptForAgentUpdates(
            agent,
            providers,
            personaNames,
            toolsByCategory,
            terminal,
            llmService,
            configService,
            currentProviderInfo,
            fieldToUpdate,
            mcpServerData,
          ),
        catch: (error) =>
          new ValidationError({
            field: "agent",
            message: `Agent edit wizard failed: ${error instanceof Error ? error.message : String(error)}`,
          }),
      });

      if (editAnswers === null) {
        yield* terminal.info("Edit cancelled.");
        if (shouldReturnToEditAgentMenu("cancelled")) {
          continue;
        }
        return;
      }

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
        yield* terminal.debug(
          `Available categories in toolsByCategory: ${Object.keys(toolsByCategory).join(", ")}`,
        );
        yield* logger.debug(`Selected category display names: ${editAnswers.tools.join(", ")}`);
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
              yield* terminal.debug(
                `Found category "${normalizedKey}" using case-insensitive match for "${selectedDisplayName}"`,
              );
            }
          }

          if (toolsInCategory && toolsInCategory.length > 0) {
            yield* logger.debug(
              `Found ${toolsInCategory.length} tools in category "${selectedDisplayName}": ${toolsInCategory.slice(0, 5).join(", ")}${toolsInCategory.length > 5 ? "..." : ""}`,
            );
            yield* terminal.debug(
              `Found ${toolsInCategory.length} tools in category "${selectedDisplayName}": ${toolsInCategory.slice(0, 5).join(", ")}${toolsInCategory.length > 5 ? "..." : ""}`,
            );
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
        yield* terminal.debug(
          `Total unique tool names from selected categories: ${uniqueToolNames.length} tools: ${uniqueToolNames.slice(0, 10).join(", ")}${uniqueToolNames.length > 10 ? "..." : ""}`,
        );

        // Always update tools with the actual tool names (including newly registered MCP tools)
        editAnswers.tools = uniqueToolNames;
      }

      // Build updated configuration
      let updatedConfig: AgentConfig = {
        ...agent.config,
        ...(editAnswers.persona && { persona: editAnswers.persona }),
        ...(editAnswers.llmProvider && { llmProvider: editAnswers.llmProvider }),
        ...(editAnswers.llmModel && { llmModel: editAnswers.llmModel }),
        ...(editAnswers.reasoningEffort && { reasoningEffort: editAnswers.reasoningEffort }),
        ...(typeof editAnswers.numCtx === "number" && { numCtx: editAnswers.numCtx }),
        ...(typeof editAnswers.maxContextTokens === "number" && {
          maxContextTokens: editAnswers.maxContextTokens,
        }),
        ...(editAnswers.tools &&
          editAnswers.tools.length > 0 && { tools: Array.from(new Set(editAnswers.tools)) }),
        ...(editAnswers.webSearchProvider && { webSearchProvider: editAnswers.webSearchProvider }),
      };
      if (editAnswers.maxContextTokens === null) {
        const { maxContextTokens: _cleared, ...withoutCeiling } = updatedConfig;
        void _cleared;
        updatedConfig = withoutCeiling;
      }
      if (editAnswers.llmApiKeyProvider) {
        updatedConfig = setAgentApiKeyOverride(
          updatedConfig,
          editAnswers.llmApiKeyProvider,
          editAnswers.llmApiKeyValue,
        );
      }

      // Build update object. The description guard uses !== undefined (not a
      // truthy check) so a user clearing the description by submitting empty
      // input actually clears the stored value; a truthy guard would silently
      // ignore the submission and leave the previous description in place.
      const updates: Partial<Agent> = {
        ...(editAnswers.name && { name: editAnswers.name }),
        ...(editAnswers.description !== undefined && { description: editAnswers.description }),
        config: updatedConfig,
      };

      yield* agentService.updateAgent(agent.id, updates);
      yield* terminal.success("Agent updated successfully!");
      yield* terminal.log("");

      agent = yield* getAgentByIdentifier(agent.id);
      if (!shouldReturnToEditAgentMenu("updated")) {
        return;
      }
    }
  });
}

/**
 * Prompt for agent updates
 */
async function promptForAgentUpdates(
  currentAgent: Agent,
  providers: readonly { name: ProviderName; displayName?: string; configured: boolean }[],
  personaNames: readonly string[],
  toolsByCategory: Record<string, readonly string[]>, // { displayName: string[] }
  terminal: TerminalService,
  llmService: LLMService,
  configService: AgentConfigService,
  currentProviderInfo: LLMProvider | null,
  fieldToUpdate: string,
  mcpServerData: {
    categories: Record<string, readonly string[]>;
    displayNameToServerName: Map<string, string>;
  },
): Promise<AgentEditAnswers | null> {
  const answers: AgentEditAnswers = {};

  // Update name
  if (fieldToUpdate === "name") {
    const name = await Effect.runPromise(
      terminal.ask("Enter new agent name:", {
        defaultValue: currentAgent.name,
        cancellable: true,
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
    if (name === undefined) {
      return null;
    }
    answers.name = name;
  }

  // Update description
  if (fieldToUpdate === "description") {
    const description = await Effect.runPromise(
      terminal.ask("Enter new agent description:", {
        defaultValue: currentAgent.description || "",
        cancellable: true,
        validate: (inputValue: string) => {
          if (inputValue.length > 500) {
            return "Agent description must be 500 characters or less";
          }
          return true;
        },
      }),
    );
    if (description === undefined) {
      return null;
    }
    answers.description = description;
  }

  // Update persona
  if (fieldToUpdate === "persona") {
    const persona = await Effect.runPromise(
      terminal.select<string>("Select agent persona:", {
        choices: personaNames.map((name) => ({ name, value: name })),
        ...(currentAgent.config.persona || personaNames[0]
          ? { default: currentAgent.config.persona || personaNames[0] }
          : {}),
      }),
    );

    if (!persona) {
      return null;
    }

    answers.persona = persona;
  }

  // Update LLM provider
  if (fieldToUpdate === "llmProvider") {
    while (true) {
      const llmProvider = await Effect.runPromise(
        terminal.search<ProviderName>("Select LLM provider:", {
          choices: sortProvidersForPicker(
            providers,
            (provider) => provider.name,
            (provider) => provider.displayName,
          ).map((provider) => ({
            name: provider.displayName ?? provider.name,
            value: provider.name,
          })),
        }),
      );

      if (!llmProvider) {
        return null;
      }

      answers.llmProvider = llmProvider;
      const providerDisplayName =
        providers.find((p) => p.name === llmProvider)?.displayName ?? llmProvider;

      const keyResult = await ensureProviderApiKey({
        configService,
        terminal,
        provider: llmProvider,
        displayName: providerDisplayName,
        required: llmProvider !== "ollama" && llmProvider !== "llamacpp",
      });
      if (keyResult === "cancelled") {
        continue;
      }

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
        return null;
      }

      answers.llmModel = llmModel;

      if (llmProvider === "ollama" && isOllamaCloudModel(llmModel)) {
        const cloudKey = await ensureProviderApiKey({
          configService,
          terminal,
          provider: "ollama",
          displayName: providerDisplayName,
          required: true,
          reason:
            "This is an Ollama Cloud model. Requests go to ollama.com and need an API key from https://ollama.com/settings/keys.",
        });
        if (cloudKey === "cancelled") {
          continue;
        }
      }

      const selectedModelInfo = providerInfo.supportedModels.find((model) => model.id === llmModel);
      const isReasoningModel = selectedModelInfo?.isReasoningModel ?? false;

      if (isReasoningModel) {
        const reasoningEffort = await promptForReasoningEffort(terminal, currentAgent);
        if (reasoningEffort === null) {
          return null;
        }
        answers.reasoningEffort = reasoningEffort;
      }

      break;
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
      return null;
    }

    answers.llmModel = llmModel;

    if (providerToUse === "ollama" && isOllamaCloudModel(llmModel)) {
      const cloudKey = await ensureProviderApiKey({
        configService,
        terminal,
        provider: "ollama",
        displayName: formatProviderDisplayName(providerToUse),
        required: true,
        reason:
          "This is an Ollama Cloud model. Requests go to ollama.com and need an API key from https://ollama.com/settings/keys.",
      });
      if (cloudKey === "cancelled") {
        return null;
      }
    }

    // Check if the selected model is a reasoning model
    const selectedModelInfo = providerInfo.supportedModels.find((model) => model.id === llmModel);
    const isReasoningModel = selectedModelInfo?.isReasoningModel ?? false;

    // If it's a reasoning model, ask for reasoning effort level
    if (isReasoningModel) {
      const reasoningEffort = await promptForReasoningEffort(terminal, currentAgent);
      if (reasoningEffort === null) {
        return null;
      }
      answers.reasoningEffort = reasoningEffort;
    }
  }

  if (fieldToUpdate === "llmApiKey") {
    while (true) {
      const provider = await Effect.runPromise(
        terminal.select<ProviderName>("Select provider for agent API key override:", {
          choices: sortProvidersForPicker(AVAILABLE_PROVIDERS).map((provider) => ({
            name: formatProviderDisplayName(provider),
            value: provider,
          })),
          default: currentAgent.config.llmProvider,
        }),
      );
      if (!provider) {
        return null;
      }

      const existingAgentOverride = currentAgent.config.llmApiKeys?.[provider];
      const isOptional = provider === "ollama" || provider === "llamacpp";
      if (existingAgentOverride) {
        await Effect.runPromise(
          terminal.info(
            `Agent override exists for ${formatProviderDisplayName(provider)}. Submit empty value to clear and use global/env fallback.`,
          ),
        );
      }

      const apiKey = await Effect.runPromise(
        terminal.ask(
          `Enter ${formatProviderDisplayName(provider)} API key override (leave empty to clear override):`,
          {
            simple: true,
            secret: true,
            cancellable: true,
            placeholder: "Paste your API key... (Esc to go back)",
            validate: (inputValue: string): boolean | string => {
              if (!isOptional && inputValue.trim().length === 0) {
                return true;
              }
              return true;
            },
          },
        ),
      );

      if (apiKey === undefined) {
        continue;
      }

      answers.llmApiKeyProvider = provider;
      if (apiKey.trim()) {
        answers.llmApiKeyValue = apiKey;
      } else {
        delete answers.llmApiKeyValue;
      }
      break;
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
          choices: Object.keys(toolsByCategory)
            .filter(
              (category) =>
                category !== SKILLS_CATEGORY.displayName &&
                category !== USER_INTERACTION_CATEGORY.displayName,
            )
            .map((category) => ({
              name: `${category} ${toolsByCategory[category]?.length ? `(${toolsByCategory[category]?.length} tools)` : ""}`,
              value: category,
            })),
          ...(selectedCategories.filter((c) => c !== SKILLS_CATEGORY.displayName).length > 0
            ? { default: selectedCategories.filter((c) => c !== SKILLS_CATEGORY.displayName) }
            : {}),
        }),
      );

      if (selectedCategories.includes(searchCategoryName)) {
        const providerName = currentAgent.config.llmProvider;
        if (providerName) {
          const webSearchProvider = await Effect.runPromise(
            handleWebSearchConfiguration(terminal, configService, llmService, providerName),
          );

          if (webSearchProvider === false) {
            selectedCategories = selectedCategories.filter((c) => c !== searchCategoryName);
            await Effect.runPromise(terminal.log(""));
            continue;
          }

          if (webSearchProvider === "builtin") {
            selectedCategories = selectedCategories.filter((c) => c !== searchCategoryName);
          } else {
            answers.webSearchProvider = webSearchProvider;
          }
        }
      }

      break;
    }

    // Store display names - will be converted to tool names in the calling function
    answers.tools = [...selectedCategories];
  }

  if (fieldToUpdate === "reasoningEffort") {
    const reasoningEffort = await promptForReasoningEffort(terminal, currentAgent);
    if (reasoningEffort === null) {
      return null;
    }
    answers.reasoningEffort = reasoningEffort;
  }

  if (fieldToUpdate === "contextWindow") {
    const detectedContextWindow = currentProviderInfo?.supportedModels.find(
      (model) => model.id === currentAgent.config.llmModel,
    )?.contextWindow;
    const result = await Effect.runPromise(
      terminal.select<number>("What context window should this agent use?", {
        choices: buildOllamaContextChoices(detectedContextWindow),
        default: currentAgent.config.numCtx ?? defaultOllamaContextWindow(detectedContextWindow),
      }),
    );
    if (result === undefined) {
      return null;
    }
    answers.numCtx = result;
  }

  if (fieldToUpdate === "maxContextTokens") {
    const result = await Effect.runPromise(promptForMaxContextTokens(terminal, currentAgent));
    if (result === undefined) {
      return null;
    }
    answers.maxContextTokens = result;
  }

  return answers;
}

function setAgentApiKeyOverride(
  config: AgentConfig,
  provider: ProviderName,
  apiKey: string | undefined,
): AgentConfig {
  const nextMap = { ...(config.llmApiKeys ?? {}) };
  if (apiKey && apiKey.length > 0) {
    nextMap[provider] = apiKey;
  } else {
    delete nextMap[provider];
  }

  if (Object.keys(nextMap).length === 0) {
    const { llmApiKeys: _unused, ...rest } = config;
    void _unused;
    return rest;
  }

  return { ...config, llmApiKeys: nextMap };
}

export const MIN_AGENT_MAX_CONTEXT_TOKENS = 1_000;

/**
 * Ask for the agent's context ceiling. Returns the new value, `null` to remove an
 * existing ceiling, or `undefined` when the user cancelled and nothing should change.
 */
function promptForMaxContextTokens(
  terminal: TerminalService,
  currentAgent: Agent,
): Effect.Effect<number | null | undefined, never> {
  const current = currentAgent.config.maxContextTokens;
  return terminal
    .ask(
      `Max context tokens for this agent? (blank = use the model's full window, min ${MIN_AGENT_MAX_CONTEXT_TOKENS.toLocaleString()})`,
      {
        ...(typeof current === "number" ? { defaultValue: String(current) } : {}),
        cancellable: true,
        validate: (input: string) => {
          const trimmed = input.trim();
          if (trimmed.length === 0) return true;
          const parsed = Number(trimmed);
          if (!Number.isInteger(parsed) || parsed < MIN_AGENT_MAX_CONTEXT_TOKENS) {
            return `Enter a whole number of at least ${MIN_AGENT_MAX_CONTEXT_TOKENS.toLocaleString()}, or leave blank to remove the limit.`;
          }
          return true;
        },
      },
    )
    .pipe(
      Effect.map((answer) => {
        if (answer === undefined) return undefined;
        const trimmed = answer.trim();
        if (trimmed.length === 0) return null;
        const parsed = Number(trimmed);
        return Number.isInteger(parsed) && parsed >= MIN_AGENT_MAX_CONTEXT_TOKENS ? parsed : null;
      }),
    );
}

async function promptForReasoningEffort(
  terminal: TerminalService,
  currentAgent: Agent,
): Promise<"disable" | "low" | "medium" | "high" | null> {
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
    return null;
  }

  return result;
}
