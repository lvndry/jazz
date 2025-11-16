import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import inquirer from "inquirer";
import { agentPromptBuilder } from "../../core/agent/agent-prompt";
import { AgentRunner, type AgentRunnerOptions } from "../../core/agent/agent-runner";
import {
  AgentServiceTag,
  getAgentByIdentifier,
  type AgentService,
} from "../../core/agent/agent-service";
import type { ToolRegistry } from "../../core/agent/tools/tool-registry";
import { ToolRegistryTag } from "../../core/agent/tools/tool-registry";
import {
  AgentAlreadyExistsError,
  AgentConfigurationError,
  AgentNotFoundError,
  StorageError,
  StorageNotFoundError,
  ValidationError,
} from "../../core/types/errors";
import type { Agent, AgentConfig } from "../../core/types/index";
import { CommonSuggestions } from "../../core/utils/error-handler";
import { MarkdownRenderer } from "../../core/utils/markdown-renderer";
import type { ConfigService } from "../../services/config";
import type { ChatMessage } from "../../services/llm/types";
import {
  LLMConfigurationError,
  LLMRateLimitError,
  LLMRequestError,
  LLMServiceTag,
  type LLMService,
} from "../../services/llm/types";
import { LoggerServiceTag, type LoggerService } from "../../services/logger";
import { FileSystemContextServiceTag, type FileSystemContextService } from "../../services/shell";

/**
 * CLI commands for AI-powered chat agent management
 *
 * These commands handle conversational AI agents that can interact with users through
 * natural language chat interfaces. They integrate with LLM providers and support
 * interactive creation wizards, real-time chat, and tool usage.
 */

interface AIAgentCreationAnswers {
  name: string;
  description: string;
  agentType: string;
  llmProvider: string;
  llmModel: string;
  reasoningEffort?: "disable" | "low" | "medium" | "high";
  tools: string[];
}

/**
 * Interactive AI agent creation command
 */
export function createAIAgentCommand(): Effect.Effect<
  void,
  | StorageError
  | AgentAlreadyExistsError
  | AgentConfigurationError
  | ValidationError
  | LLMConfigurationError,
  AgentService | LLMService | ToolRegistry
> {
  return Effect.gen(function* () {
    console.log("🤖 Welcome to the Jazz AI Agent Creation Wizard!");
    console.log("Let's create a new AI agent step by step.\n");

    // Get available LLM providers and models
    const llmService = yield* LLMServiceTag;
    const providers = yield* llmService.listProviders();

    if (providers.length === 0) {
      return yield* Effect.fail(
        new LLMConfigurationError(
          "no_providers",
          "No LLM providers configured. Set an API key for at least one provider in the config.",
        ),
      );
    }

    // Get available agent types
    const agentTypes = yield* agentPromptBuilder.listTemplates();

    // Get available tools by category
    const toolRegistry = yield* ToolRegistryTag;
    const toolsByCategory = yield* toolRegistry.listToolsByCategory();

    // Get agent basic information
    const agentAnswers = yield* Effect.promise(() =>
      promptForAgentInfo(providers, agentTypes, toolsByCategory, llmService),
    );

    // Validate the chosen model against the chosen provider
    const chosenProvider = yield* llmService.getProvider(agentAnswers.llmProvider);
    const modelIds: string[] = chosenProvider.supportedModels.map((model) => model.id);
    const selectedModel = modelIds.includes(agentAnswers.llmModel)
      ? agentAnswers.llmModel
      : chosenProvider.defaultModel;

    // Convert selected categories to a flat list of tool names
    const selectedToolNames = agentAnswers.tools.flatMap((category) => toolsByCategory[category] || []);
    const uniqueToolNames = Array.from(new Set(selectedToolNames));

    // Build agent configuration
    const config: AgentConfig = {
      tasks: [],
      agentType: agentAnswers.agentType,
      llmProvider: agentAnswers.llmProvider,
      llmModel: selectedModel,
      ...(agentAnswers.reasoningEffort && { reasoningEffort: agentAnswers.reasoningEffort }),
      ...(uniqueToolNames.length > 0 && { tools: uniqueToolNames }),
      environment: {},
    };

    const agentService = yield* AgentServiceTag;
    const agent = yield* agentService.createAgent(
      agentAnswers.name,
      agentAnswers.description,
      config,
    );

    // Display success message
    console.log("\n✅ AI Agent created successfully!");
    console.log(`   ID: ${agent.id}`);
    console.log(`   Name: ${agent.name}`);
    console.log(`   Description: ${agent.description}`);
    console.log(`   Type: ${config.agentType}`);
    console.log(`   LLM Provider: ${config.llmProvider}`);
    console.log(`   LLM Model: ${config.llmModel}`);
    console.log(`   Tool Categories: ${agentAnswers.tools.join(", ") || "None"}`);
    console.log(`   Total Tools: ${uniqueToolNames.length}`);
    console.log(`   Status: ${agent.status}`);
    console.log(`   Created: ${agent.createdAt.toISOString()}`);

    console.log("\nYou can now chat with your agent using:");
    console.log(`   • By ID:   jazz agent chat ${agent.id}`);
    console.log(`   • By name: jazz agent chat ${agent.name}`);
  });
}

/**
 * Prompt for basic agent information
 */
async function promptForAgentInfo(
  providers: readonly string[],
  agentTypes: readonly string[],
  toolsByCategory: Record<string, readonly string[]>,
  llmService: LLMService,
): Promise<AIAgentCreationAnswers> {
  // First, get basic information and provider
  const basicQuestions = [
    {
      type: "input",
      name: "name",
      message: "What would you like to name your AI agent?",
      validate: (input: string): boolean | string => {
        if (!input || input.trim().length === 0) {
          return "Agent name cannot be empty";
        }
        if (input.length > 100) {
          return "Agent name cannot exceed 100 characters";
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(input)) {
          return "Agent name can only contain letters, numbers, underscores, and hyphens";
        }
        return true;
      },
    },
    {
      type: "input",
      name: "description",
      message: "Describe what this AI agent will do:",
      validate: (input: string): boolean | string => {
        if (!input || input.trim().length === 0) {
          return "Agent description cannot be empty";
        }
        if (input.length > 500) {
          return "Agent description cannot exceed 500 characters";
        }
        return true;
      },
    },
    {
      type: "list",
      name: "agentType",
      message: "What type of agent would you like to create?",
      choices: agentTypes,
      default: "default",
    },
    {
      type: "list",
      name: "llmProvider",
      message: "Which LLM provider would you like to use?",
      choices: providers,
      default: providers[0],
    },
  ];

  // @ts-expect-error - inquirer types are not matching correctly
  const basicAnswers = (await inquirer.prompt(basicQuestions)) as Pick<
    AIAgentCreationAnswers,
    "name" | "description" | "agentType" | "llmProvider"
  >;

  // Now get the models for the chosen provider
  const chosenProviderInfo = await Effect.runPromise(
    llmService.getProvider(basicAnswers.llmProvider),
  ).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to get provider info: ${message}`);
  });

  const modelDefault = chosenProviderInfo.defaultModel;

  // Check if the selected model is a reasoning model
  const selectedModelInfo = chosenProviderInfo.supportedModels.find(
    (model) => model.id === modelDefault,
  );
  const isReasoningModel = selectedModelInfo?.isReasoningModel ?? false;

  const finalQuestions = [
    {
      type: "list",
      name: "llmModel",
      message: "Which model would you like to use?",
      choices: chosenProviderInfo.supportedModels.map((model) => ({
        name: model.displayName || model.id,
        value: model.id,
        short: model.displayName || model.id,
      })) as Array<{ name: string; value: string; short: string }>,
      default: modelDefault,
    },
    // Only show reasoning effort question for reasoning models
    ...(isReasoningModel
      ? [
          {
            type: "list",
            name: "reasoningEffort",
            message: "What reasoning effort level would you like?",
            choices: [
              { name: "Disable - No reasoning effort (fastest)", value: "disable" },
              { name: "Low - Faster responses, basic reasoning", value: "low" },
              { name: "Medium - Balanced speed and reasoning depth", value: "medium" },
              { name: "High - Deep reasoning, slower responses", value: "high" },
            ],
            default: "disable",
          },
        ]
      : []),
    {
      type: "checkbox",
      name: "tools",
      message: "Which tools should this agent have access to?",
      choices: Object.entries(toolsByCategory).map(([category, tools]) => ({
        name: `${category} (${tools.length} ${tools.length === 1 ? "tool" : "tools"})`,
        value: category,
        short: category,
      })),
      default: [],
    },
  ];

  // @ts-expect-error - inquirer types are not matching correctly
  const finalAnswers = (await inquirer.prompt(finalQuestions)) as Pick<
    AIAgentCreationAnswers,
    "llmModel" | "reasoningEffort" | "tools"
  >;

  // Combine all answers
  return {
    ...basicAnswers,
    ...finalAnswers,
  };
}

/**
 * Chat with an AI agent
 */
export function chatWithAIAgentCommand(
  agentIdentifier: string,
  options?: {
    stream?: boolean;
    noStream?: boolean;
  },
): Effect.Effect<
  void,
  StorageError | StorageNotFoundError | AgentNotFoundError,
  | AgentService
  | ConfigService
  | LLMService
  | ToolRegistry
  | LoggerService
  | FileSystemContextService
  | FileSystem.FileSystem
> {
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

    console.log(`🤖 Starting chat with AI agent: ${agent.name} (${agent.id})`);
    console.log(`   Description: ${agent.description}`);
    console.log();
    console.log("Type 'exit' or 'quit' to end the conversation.");
    console.log("Type '/help' to see available special commands.");
    console.log();

    // Start the chat loop with error logging
    yield* startChatLoop(agent, options).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          const logger = yield* LoggerServiceTag;
          yield* logger.error("Chat loop error", { error });
          console.error("❌ Chat loop error:", error);
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
  FileSystemContextService | LoggerService | FileSystem.FileSystem | ConfigService
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
  type: "new" | "help" | "status" | "clear" | "tools" | "edit" | "unknown";
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
  { shouldContinue: boolean; newConversationId?: string | undefined; newHistory?: ChatMessage[] },
  never,
  ToolRegistry
> {
  return Effect.gen(function* () {
    switch (command.type) {
      case "new":
        console.log("🆕 Starting new conversation...");
        console.log("   • Conversation context cleared");
        console.log("   • Fresh start with the agent");
        console.log();
        return {
          shouldContinue: true,
          newConversationId: undefined,
          newHistory: [],
        };

      case "help":
        console.log("📖 Available special commands:");
        console.log("   /new     - Start a new conversation (clear context)");
        console.log("   /status  - Show current conversation status");
        console.log("   /tools   - List all available tools by category");
        console.log("   /edit    - Edit this agent's configuration");
        console.log("   /clear   - Clear the screen");
        console.log("   /help    - Show this help message");
        console.log("   exit     - Exit the chat");
        console.log();
        return { shouldContinue: true };

      case "status": {
        console.log("📊 Conversation Status:");
        console.log(`   Agent: ${agent.name} (${agent.id})`);
        console.log(`   Conversation ID: ${conversationId || "Not started"}`);
        console.log(`   Messages in history: ${conversationHistory.length}`);
        console.log(`   Agent type: ${agent.config.agentType}`);
        console.log(`   LLM: ${agent.config.llmProvider}/${agent.config.llmModel}`);
        const totalTools = agent.config.tools?.length ?? 0;
        console.log(`   Tools: ${totalTools} available`);
        console.log();
        return { shouldContinue: true };
      }

      case "tools": {
        const toolRegistry = yield* ToolRegistryTag;
        const toolsByCategory = yield* toolRegistry.listToolsByCategory();

        console.log("🔧 Available Tools by Category:");
        console.log();

        if (Object.keys(toolsByCategory).length === 0) {
          console.log("   No tools available.");
        } else {
          // Sort categories alphabetically
          const sortedCategories = Object.keys(toolsByCategory).sort();

          for (const category of sortedCategories) {
            const tools = toolsByCategory[category];
            if (tools && tools.length > 0) {
              console.log(
                `   📁 ${category} (${tools.length} ${tools.length === 1 ? "tool" : "tools"}):`,
              );
              for (const tool of tools) {
                console.log(`      • ${tool}`);
              }
              console.log();
            }
          }

          // Show total count
          const totalTools = Object.values(toolsByCategory).reduce(
            (sum, tools) => sum + (tools?.length || 0),
            0,
          );
          console.log(`   Total: ${totalTools} tools across ${sortedCategories.length} categories`);
        }
        console.log();
        return { shouldContinue: true };
      }

      case "clear":
        console.clear();
        console.log(`🤖 Chat with ${agent.name} - Screen cleared`);
        console.log("Type 'exit' or 'quit' to end the conversation.");
        console.log("Type '/help' to see available commands.");
        console.log();
        return { shouldContinue: true };

      case "unknown":
        console.log(`❓ Unknown command: /${command.args.join(" ")}`);
        console.log("Type '/help' to see available commands.");
        console.log();
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
  streamingOptions?: {
    stream?: boolean;
    noStream?: boolean;
  },
): Effect.Effect<
  void,
  Error,
  | ConfigService
  | LLMService
  | ToolRegistry
  | LoggerService
  | FileSystemContextService
  | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    let chatActive = true;
    let conversationId: string | undefined;
    let conversationHistory: ChatMessage[] = [];
    let sessionInitialized = false;

    while (chatActive) {
      // Prompt for user input
      const answer = yield* Effect.promise(() =>
        inquirer.prompt([
          {
            type: "input",
            name: "message",
            message: "You:",
          },
        ]),
      );

      const userMessage = answer.message as string;

      // Check if user wants to exit
      if (userMessage.toLowerCase() === "exit" || userMessage.toLowerCase() === "quit") {
        console.log("👋 Goodbye!");
        chatActive = false;
        continue;
      }

      // Ignore empty messages with a gentle hint
      if (!userMessage || userMessage.trim().length === 0) {
        console.log(
          "(Tip) Type a message and press Enter, '/help' for commands, or 'exit' to quit.",
        );
        continue;
      }

      // Check for special commands
      const specialCommand = parseSpecialCommand(userMessage);
      if (specialCommand.type !== "unknown") {
        const commandResult = yield* handleSpecialCommand(
          specialCommand,
          agent,
          conversationId,
          conversationHistory,
        );

        if (commandResult.newConversationId !== undefined) {
          conversationId = commandResult.newConversationId;
        }
        if (commandResult.newHistory !== undefined) {
          conversationHistory = commandResult.newHistory;
        }

        continue;
      }

      try {
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
          ...(streamingOptions?.stream !== undefined ? { forceStream: streamingOptions.stream } : {}),
          ...(streamingOptions?.noStream !== undefined
            ? { forceNoStream: streamingOptions.noStream }
            : {}),
        };

        // Run the agent
        const response = yield* AgentRunner.run(options);

        // Store the conversation ID for continuity
        conversationId = response.conversationId;

        // Persist conversation history for next turn
        if (response.messages) {
          conversationHistory = response.messages;
        }

        // Display the response only if it wasn't already streamed
        // In streaming mode, the response is displayed in real-time by StreamRenderer
        if (!response.wasStreamed) {
          console.log();
          console.log(MarkdownRenderer.formatAgentResponse(agent.name, response.content));
          console.log();
        }
      } catch (error) {
        console.log();

        // Handle different error types with appropriate user feedback
        if (error instanceof LLMRateLimitError) {
          console.log(
            `⏳ Rate limit exceeded. The request was too large or you've hit your API limits.`,
          );
          console.log(`   Please try again in a moment or consider using a smaller context.`);
          console.log(`   Error details: ${error.message}`);
        } else if (error instanceof LLMRequestError) {
          console.log(`❌ LLM request failed: ${error.message}`);
          console.log(`   This might be a temporary issue. Please try again.`);
        } else {
          console.log(`❌ Error: ${error instanceof Error ? error.message : String(error)}`);
        }
        console.log();

        const logger = yield* LoggerServiceTag;
        yield* logger.error("Agent chat processing error", { error });
      }
    }
  });
}
