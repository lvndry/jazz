import { Effect } from "effect";
import inquirer from "inquirer";
import { agentPromptBuilder } from "../../core/agent/agent-prompt";
import {
  AgentServiceTag,
  getAgentByIdentifier,
  type AgentService,
} from "../../core/agent/agent-service";
import { createCategoryMappings } from "../../core/agent/tools/register-tools";
import { ToolRegistryTag, type ToolRegistry } from "../../core/agent/tools/tool-registry";
import { normalizeToolConfig } from "../../core/agent/utils/tool-config";
import {
  AgentAlreadyExistsError,
  AgentConfigurationError,
  LLMConfigurationError,
  StorageError,
  StorageNotFoundError,
  ValidationError,
} from "../../core/types/errors";
import type { Agent, AgentConfig } from "../../core/types/index";
import type { ConfigService } from "../../services/config";
import { AgentConfigService } from "../../services/config";
import { LLMService, LLMServiceTag, type LLMProvider } from "../../services/llm/interfaces";
import type { ProviderName } from "../../services/llm/models";
import { TerminalServiceTag, type TerminalService } from "../../services/terminal";

/**
 * CLI commands for editing existing agents
 */

interface AgentEditAnswers {
  name?: string;
  description?: string;
  agentType?: string;
  llmProvider?: string;
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
  AgentService | LLMService | ToolRegistry | TerminalService | ConfigService
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
    yield* terminal.log(`   Tools: ${agent.config.tools ? agent.config.tools.length : 0} tools`);
    yield* terminal.log(`   Created: ${agent.createdAt.toISOString()}`);
    yield* terminal.log(`   Updated: ${agent.updatedAt.toISOString()}`);
    yield* terminal.log("");

    // Get available LLM providers and models
    const llmService = yield* LLMServiceTag;
    const configService = yield* AgentConfigService;
    const providers = yield* llmService.listProviders();

    // Get available agent types
    const agentTypes = yield* agentPromptBuilder.listTemplates();

    // Get available tools by category
    const toolRegistry = yield* ToolRegistryTag;
    const toolsByCategory = yield* toolRegistry.listToolsByCategory();

    // Create mappings between category display names and IDs
    const categoryMappings = createCategoryMappings();
    const categoryDisplayNameToId: Map<string, string> = categoryMappings.displayNameToId;

    // Get current provider info for model selection
    const currentProviderInfo = yield* llmService
      .getProvider(agent.config.llmProvider as ProviderName)
      .pipe(Effect.catchAll(() => Effect.succeed(null as LLMProvider | null)));

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
      ),
    );

    // Convert selected categories (display names) to category IDs, then get tools
    const selectedCategoryIds = (editAnswers.tools || [])
      .map((displayName) => categoryDisplayNameToId.get(displayName))
      .filter((id): id is string => id !== undefined);

    // Get tools for each selected category ID
    const selectedToolNames = yield* Effect.all(
      selectedCategoryIds.map((categoryId) => toolRegistry.getToolsInCategory(categoryId)),
      { concurrency: "unbounded" },
    );
    const uniqueToolNames = Array.from(new Set(selectedToolNames.flat()));

    // Update the tools in editAnswers
    if (editAnswers.tools && editAnswers.tools.length > 0) {
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
    yield* terminal.log(`   Reasoning Effort: ${updatedConfig.reasoningEffort || "N/A"}`);
    yield* terminal.log(`   Tools: ${updatedConfig.tools ? updatedConfig.tools.length : 0} tools`);
    yield* terminal.log(`   Updated: ${updatedAgent.updatedAt.toISOString()}`);
    yield* terminal.log("");
    yield* terminal.info("You can now chat with your updated agent using:");
    yield* terminal.log(`jazz agent chat ${updatedAgent.id}`);
  });
}

/**
 * Prompt for agent updates
 */
async function promptForAgentUpdates(
  currentAgent: Agent,
  providers: readonly { name: string; configured: boolean }[],
  agentTypes: readonly string[],
  toolsByCategory: Record<string, readonly string[]>, // { displayName: string[] }
  terminal: TerminalService,
  llmService: LLMService,
  configService: ConfigService,
  currentProviderInfo: LLMProvider | null,
): Promise<AgentEditAnswers> {
  const answers: AgentEditAnswers = {};

  // Ask what to update
  const { fieldsToUpdate } = await inquirer.prompt<{ fieldsToUpdate: string[] }>([
    {
      type: "checkbox",
      name: "fieldsToUpdate",
      message: "What would you like to update?",
      choices: [
        { name: "Name", value: "name" },
        { name: "Description", value: "description" },
        { name: "Agent Type", value: "agentType" },
        { name: "LLM Provider", value: "llmProvider" },
        { name: "LLM Model", value: "llmModel" },
        { name: "Tools", value: "tools" },
      ],
    },
  ]);

  if (fieldsToUpdate.length === 0) {
    terminal.warn("No fields selected for update. Exiting...");
    return answers;
  }

  // Update name
  if (fieldsToUpdate.includes("name")) {
    const { name } = await inquirer.prompt<{ name: string }>([
      {
        type: "input",
        name: "name",
        message: "Enter new agent name:",
        default: currentAgent.name,
        validate: (input: string) => {
          if (!input.trim()) {
            return "Agent name cannot be empty";
          }
          if (input.length > 100) {
            return "Agent name must be 100 characters or less";
          }
          return true;
        },
      },
    ]);
    answers.name = name;
  }

  // Update description
  if (fieldsToUpdate.includes("description")) {
    const { description } = await inquirer.prompt<{ description: string }>([
      {
        type: "input",
        name: "description",
        message: "Enter new agent description:",
        default: currentAgent.description || "",
        validate: (input: string) => {
          if (!input.trim()) {
            return "Agent description cannot be empty";
          }
          if (input.length > 500) {
            return "Agent description must be 500 characters or less";
          }
          return true;
        },
      },
    ]);
    answers.description = description;
  }

  // Update agent type
  if (fieldsToUpdate.includes("agentType")) {
    const { agentType } = await inquirer.prompt<{ agentType: string }>([
      {
        type: "list",
        name: "agentType",
        message: "Select agent type:",
        choices: agentTypes.map((type) => ({ name: type, value: type })),
        default: currentAgent.config.agentType || agentTypes[0],
      },
    ]);
    answers.agentType = agentType;
  }

  // Update LLM provider
  if (fieldsToUpdate.includes("llmProvider")) {
    const { llmProvider } = await inquirer.prompt<{ llmProvider: string }>([
      {
        type: "list",
        name: "llmProvider",
        message: "Select LLM provider:",
        choices: providers.map((provider) => ({
          name: provider.name,
          value: provider.name,
        })),
        default: currentAgent.config.llmProvider || providers.find((p) => p.configured)?.name,
      },
    ]);
    answers.llmProvider = llmProvider;

    // Check if API key exists for the selected provider
    const apiKeyPath = `llm.${llmProvider}.api_key`;
    const hasApiKey = await Effect.runPromise(configService.has(apiKeyPath));

    if (!hasApiKey) {
      // Show message and prompt for API key
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* terminal.log("");
          yield* terminal.warn(`API key not set in config file for ${llmProvider}.`);
          yield* terminal.log("Please paste your API key below:");
        }),
      );

      const { apiKey } = await inquirer.prompt<{ apiKey: string }>([
        {
          type: "input",
          name: "apiKey",
          message: `${llmProvider} API Key:`,
          validate: (input: string): boolean | string => {
            if (!input || input.trim().length === 0) {
              return "API key cannot be empty";
            }
            return true;
          },
        },
      ]);

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
    const providerInfo = await Effect.runPromise(
      llmService.getProvider(llmProvider as ProviderName),
    ).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to get provider info: ${message}`);
    });

    const { llmModel } = await inquirer.prompt<{ llmModel: string }>([
      {
        type: "list",
        name: "llmModel",
        message: `Select model for ${llmProvider}:`,
        choices: providerInfo.supportedModels.map((model) => ({
          name: model.displayName || model.id,
          value: model.id,
        })),
        default: providerInfo.defaultModel,
      },
    ]);
    answers.llmModel = llmModel;

    // Check if the selected model is a reasoning model
    const selectedModelInfo = providerInfo.supportedModels.find((model) => model.id === llmModel);
    const isReasoningModel = selectedModelInfo?.isReasoningModel ?? false;

    // If it's a reasoning model, ask for reasoning effort level
    if (isReasoningModel) {
      const { reasoningEffort } = await inquirer.prompt<{
        reasoningEffort: "disable" | "low" | "medium" | "high";
      }>([
        {
          type: "list",
          name: "reasoningEffort",
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
          default: currentAgent.config.reasoningEffort || "medium",
        },
      ]);
      answers.reasoningEffort = reasoningEffort;
    }
  }

  // Update LLM model (only if provider wasn't already updated)
  if (fieldsToUpdate.includes("llmModel") && !answers.llmProvider) {
    // Use current provider to get available models
    const providerToUse = currentAgent.config.llmProvider;
    const providerInfo =
      currentProviderInfo ||
      (await Effect.runPromise(llmService.getProvider(providerToUse as ProviderName)).catch(
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Failed to get provider info: ${message}`);
        },
      ));

    const { llmModel } = await inquirer.prompt<{ llmModel: string }>([
      {
        type: "list",
        name: "llmModel",
        message: `Select model for ${providerToUse}:`,
        choices: providerInfo.supportedModels.map((model) => ({
          name: model.displayName || model.id,
          value: model.id,
        })),
        default: currentAgent.config.llmModel || providerInfo.defaultModel,
      },
    ]);
    answers.llmModel = llmModel;

    // Check if the selected model is a reasoning model
    const selectedModelInfo = providerInfo.supportedModels.find((model) => model.id === llmModel);
    const isReasoningModel = selectedModelInfo?.isReasoningModel ?? false;

    // If it's a reasoning model, ask for reasoning effort level
    if (isReasoningModel) {
      const { reasoningEffort } = await inquirer.prompt<{
        reasoningEffort: "disable" | "low" | "medium" | "high";
      }>([
        {
          type: "list",
          name: "reasoningEffort",
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
          default: currentAgent.config.reasoningEffort || "medium",
        },
      ]);
      answers.reasoningEffort = reasoningEffort;
    }
  }

  // Update tools
  if (fieldsToUpdate.includes("tools")) {
    // Get current agent's tool names
    const currentToolNames = normalizeToolConfig(currentAgent.config.tools, {
      agentId: currentAgent.id,
    });
    const currentToolSet = new Set(currentToolNames);

    // Find which categories contain the agent's current tools
    const defaultCategories: string[] = [];
    for (const [category, tools] of Object.entries(toolsByCategory)) {
      // Check if any of the agent's tools are in this category
      if (tools.some((tool) => currentToolSet.has(tool))) {
        defaultCategories.push(category);
      }
    }

    const { toolCategories } = await inquirer.prompt<{ toolCategories: string[] }>([
      {
        type: "checkbox",
        name: "toolCategories",
        message: "Select tool categories:",
        choices: Object.keys(toolsByCategory).map((category) => ({
          name: `${category} (${toolsByCategory[category]?.length || 0} tools)`,
          value: category,
        })),
        default: defaultCategories,
      },
    ]);

    // Store display names - will be converted to tool names in the calling function
    answers.tools = toolCategories;
  }

  return answers;
}
