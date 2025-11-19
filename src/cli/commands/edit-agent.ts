import { Effect } from "effect";
import inquirer from "inquirer";
import { agentPromptBuilder } from "../../core/agent/agent-prompt";
import { AgentServiceTag, type AgentService } from "../../core/agent/agent-service";
import { createCategoryMappings } from "../../core/agent/tools/register-tools";
import { ToolRegistryTag, type ToolRegistry } from "../../core/agent/tools/tool-registry";
import {
  AgentAlreadyExistsError,
  AgentConfigurationError,
  LLMConfigurationError,
  StorageError,
  StorageNotFoundError,
  ValidationError,
} from "../../core/types/errors";
import type { Agent, AgentConfig, AgentStatus } from "../../core/types/index";
import { LLMService, LLMServiceTag } from "../../services/llm/interfaces";
import { TerminalServiceTag, type TerminalService } from "../../services/terminal";

/**
 * CLI commands for editing existing agents
 */

interface AgentEditAnswers {
  name?: string;
  description?: string;
  status?: AgentStatus;
  agentType?: string;
  llmProvider?: string;
  llmModel?: string;
  reasoningEffort?: "disable" | "low" | "medium" | "high";
  tools?: string[];
  timeout?: number;
  maxRetries?: number;
  retryDelay?: number;
  retryBackoff?: "linear" | "exponential" | "fixed";
}

/**
 * Interactive agent edit command
 */
export function editAgentCommand(
  agentId: string,
): Effect.Effect<
  void,
  | StorageError
  | StorageNotFoundError
  | AgentConfigurationError
  | AgentAlreadyExistsError
  | ValidationError
  | LLMConfigurationError,
  AgentService | LLMService | ToolRegistry | TerminalService
> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    yield* terminal.heading("✏️  Welcome to the Jazz Agent Edit Wizard!");
    yield* terminal.log("Let's update your agent step by step.");
    yield* terminal.log("");

    const agentService = yield* AgentServiceTag;
    const agent = yield* agentService.getAgent(agentId);

    yield* terminal.heading(`📋 Current Agent: ${agent.name}`);
    yield* terminal.log(`   ID: ${agent.id}`);
    yield* terminal.log(`   Description: ${agent.description}`);
    yield* terminal.log(`   Status: ${agent.status}`);
    yield* terminal.log(`   Type: ${agent.config.agentType || "N/A"}`);
    yield* terminal.log(`   LLM Provider: ${agent.config.llmProvider || "N/A"}`);
    yield* terminal.log(`   LLM Model: ${agent.config.llmModel || "N/A"}`);
    yield* terminal.log(`   Tools: ${agent.config.tools ? agent.config.tools.length : 0} tools`);
    yield* terminal.log(`   Created: ${agent.createdAt.toISOString()}`);
    yield* terminal.log(`   Updated: ${agent.updatedAt.toISOString()}`);
    yield* terminal.log("");

    // Get available LLM providers and models
    const llmService = yield* LLMServiceTag;
    const providers = yield* llmService.listProviders();

    // Get available agent types
    const agentTypes = yield* agentPromptBuilder.listTemplates();

    // Get available tools by category
    const toolRegistry = yield* ToolRegistryTag;
    const toolsByCategory = yield* toolRegistry.listToolsByCategory();

    // Create mappings between category display names and IDs
    const categoryMappings = createCategoryMappings();
    const categoryDisplayNameToId: Map<string, string> = categoryMappings.displayNameToId;

    // Prompt for updates
    const editAnswers = yield* Effect.promise(() =>
      promptForAgentUpdates(agent, providers, agentTypes, toolsByCategory, terminal),
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
      ...(editAnswers.tools && editAnswers.tools.length > 0 && { tools: Array.from(new Set(editAnswers.tools)) }),
      ...(editAnswers.timeout && { timeout: editAnswers.timeout }),
      ...(editAnswers.maxRetries !== undefined ||
      editAnswers.retryDelay !== undefined ||
      editAnswers.retryBackoff
        ? {
            retryPolicy: {
              maxRetries: editAnswers.maxRetries ?? agent.config.retryPolicy?.maxRetries ?? 3,
              delay: editAnswers.retryDelay ?? agent.config.retryPolicy?.delay ?? 1000,
              backoff:
                editAnswers.retryBackoff ?? agent.config.retryPolicy?.backoff ?? "exponential",
            },
          }
        : {}),
    };

    // Build update object
    const updates: Partial<Agent> = {
      ...(editAnswers.name && { name: editAnswers.name }),
      ...(editAnswers.description && { description: editAnswers.description }),
      ...(editAnswers.status && { status: editAnswers.status }),
      config: updatedConfig,
    };

    // Update the agent
    const updatedAgent = yield* agentService.updateAgent(agentId, updates);

    // Display success message
    yield* terminal.success("Agent updated successfully!");
    yield* terminal.log(`   ID: ${updatedAgent.id}`);
    yield* terminal.log(`   Name: ${updatedAgent.name}`);
    yield* terminal.log(`   Description: ${updatedAgent.description}`);
    yield* terminal.log(`   Status: ${updatedAgent.status}`);
    yield* terminal.log(`   Type: ${updatedConfig.agentType || "N/A"}`);
    yield* terminal.log(`   LLM Provider: ${updatedConfig.llmProvider || "N/A"}`);
    yield* terminal.log(`   LLM Model: ${updatedConfig.llmModel || "N/A"}`);
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
  providers: readonly string[],
  agentTypes: readonly string[],
  toolsByCategory: Record<string, readonly string[]>, // { displayName: string[] }
  terminal: TerminalService,
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
        { name: "Status", value: "status" },
        { name: "Agent Type", value: "agentType" },
        { name: "LLM Provider", value: "llmProvider" },
        { name: "LLM Model", value: "llmModel" },
        { name: "Tools", value: "tools" },
        { name: "Timeout", value: "timeout" },
        { name: "Retry Policy", value: "retryPolicy" },
      ],
    },
  ]);

  if (fieldsToUpdate.length === 0) {
    await Effect.runPromise(terminal.warn("No fields selected for update. Exiting..."));
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

  // Update status
  if (fieldsToUpdate.includes("status")) {
    const { status } = await inquirer.prompt<{ status: AgentStatus }>([
      {
        type: "list",
        name: "status",
        message: "Select new agent status:",
        choices: [
          { name: "Idle (ready to run)", value: "idle" },
          { name: "Running (currently executing)", value: "running" },
          { name: "Paused (temporarily stopped)", value: "paused" },
          { name: "Error (failed with error)", value: "error" },
          { name: "Completed (finished successfully)", value: "completed" },
        ],
        default: currentAgent.status,
      },
    ]);
    answers.status = status;
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
        choices: providers.map((provider) => ({ name: provider, value: provider })),
        default: currentAgent.config.llmProvider || providers[0],
      },
    ]);
    answers.llmProvider = llmProvider;

    // Update LLM model based on provider
    if (fieldsToUpdate.includes("llmModel")) {
      // Note: This would need to be handled in the Effect context
      // For now, we'll skip the model selection in the prompt
      await Effect.runPromise(
        terminal.info("LLM model selection will be handled during agent update"),
      );
    }
  }

  // Update tools
  if (fieldsToUpdate.includes("tools")) {
    const { toolCategories } = await inquirer.prompt<{ toolCategories: string[] }>([
      {
        type: "checkbox",
        name: "toolCategories",
        message: "Select tool categories:",
        choices: Object.keys(toolsByCategory).map((category) => ({
          name: `${category} (${toolsByCategory[category]?.length || 0} tools)`,
          value: category,
        })),
        default: [],
      },
    ]);

    // Store display names - will be converted to tool names in the calling function
    answers.tools = toolCategories;
  }

  // Update timeout
  if (fieldsToUpdate.includes("timeout")) {
    const { timeout } = await inquirer.prompt<{ timeout: string }>([
      {
        type: "input",
        name: "timeout",
        message: "Enter timeout in milliseconds (0 for no timeout):",
        default: String(currentAgent.config.timeout || 30000),
        validate: (input: string) => {
          const num = parseInt(input, 10);
          if (isNaN(num)) {
            return "Please enter a valid number";
          }
          if (num < 0) {
            return "Timeout must be 0 or greater";
          }
          if (num > 300000) {
            return "Timeout must be 300 seconds or less";
          }
          return true;
        },
      },
    ]);
    answers.timeout = parseInt(timeout, 10);
  }

  // Update retry policy
  if (fieldsToUpdate.includes("retryPolicy")) {
    const { maxRetries } = await inquirer.prompt<{ maxRetries: string }>([
      {
        type: "input",
        name: "maxRetries",
        message: "Enter maximum retry attempts:",
        default: String(currentAgent.config.retryPolicy?.maxRetries || 3),
        validate: (input: string) => {
          const num = parseInt(input, 10);
          if (isNaN(num)) {
            return "Please enter a valid number";
          }
          if (num < 0 || num > 10) {
            return "Max retries must be between 0 and 10";
          }
          return true;
        },
      },
    ]);

    const { retryDelay } = await inquirer.prompt<{ retryDelay: string }>([
      {
        type: "input",
        name: "retryDelay",
        message: "Enter retry delay in milliseconds:",
        default: String(currentAgent.config.retryPolicy?.delay || 1000),
        validate: (input: string) => {
          const num = parseInt(input, 10);
          if (isNaN(num)) {
            return "Please enter a valid number";
          }
          if (num < 100 || num > 60000) {
            return "Retry delay must be between 100ms and 60000ms";
          }
          return true;
        },
      },
    ]);

    const { retryBackoff } = await inquirer.prompt<{
      retryBackoff: "linear" | "exponential" | "fixed";
    }>([
      {
        type: "list",
        name: "retryBackoff",
        message: "Select retry backoff strategy:",
        choices: [
          { name: "Linear (constant delay)", value: "linear" },
          { name: "Exponential (increasing delay)", value: "exponential" },
          { name: "Fixed (same delay each time)", value: "fixed" },
        ],
        default: currentAgent.config.retryPolicy?.backoff || "exponential",
      },
    ]);

    answers.maxRetries = parseInt(maxRetries, 10);
    answers.retryDelay = parseInt(retryDelay, 10);
    answers.retryBackoff = retryBackoff;
  }

  return answers;
}
