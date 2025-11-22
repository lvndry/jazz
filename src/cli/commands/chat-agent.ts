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
import {
  FILE_MANAGEMENT_CATEGORY,
  GIT_CATEGORY,
  GMAIL_CATEGORY,
  HTTP_CATEGORY,
  SHELL_COMMANDS_CATEGORY,
  WEB_SEARCH_CATEGORY,
  createCategoryMappings,
} from "../../core/agent/tools/register-tools";
import type { ToolRegistry } from "../../core/agent/tools/tool-registry";
import { ToolRegistryTag } from "../../core/agent/tools/tool-registry";
import { normalizeToolConfig } from "../../core/agent/utils/tool-config";
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
import { CommonSuggestions } from "../../core/utils/error-handler";
import type { ConfigService } from "../../services/config";
import { FileSystemContextServiceTag, type FileSystemContextService } from "../../services/fs";
import { LLMService, LLMServiceTag } from "../../services/llm/interfaces";
import { ChatMessage } from "../../services/llm/messages";
import { ProviderName } from "../../services/llm/models";
import { LoggerServiceTag, type LoggerService } from "../../services/logger";
import { TerminalServiceTag, type TerminalService } from "../../services/terminal";

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
export function createAIAgentCommand(): Effect.Effect<
  void,
  | StorageError
  | AgentAlreadyExistsError
  | AgentConfigurationError
  | ValidationError
  | LLMConfigurationError,
  AgentService | LLMService | ToolRegistry | TerminalService
> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    yield* terminal.heading("🤖 Welcome to the Jazz AI Agent Creation Wizard!");
    yield* terminal.log("Let's create a new AI agent step by step.");
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
    const categoryIdToDisplayName: Map<string, string> = categoryMappings.idToDisplayName;

    // Get agent basic information
    const agentAnswers = yield* Effect.promise(() =>
      promptForAgentInfo(
        providers,
        agentTypes,
        toolsByCategory,
        llmService,
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
      environment: {},
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
 * Prompt for basic agent information
 */
async function promptForAgentInfo(
  providers: readonly { name: string; configured: boolean }[],
  agentTypes: readonly string[],
  toolsByCategory: Record<string, readonly string[]>, //{ displayName: string[] }
  llmService: LLMService,
  categoryIdToDisplayName: Map<string, string>,
  terminal: TerminalService,
): Promise<AIAgentCreationAnswers> {
  const agentTypeQuestion = [
    {
      type: "list",
      name: "agentType",
      message: "What type of agent would you like to create?",
      choices: agentTypes,
      default: "default",
    },
  ];

  // @ts-expect-error - inquirer types are not matching correctly
  const agentTypeAnswer = (await inquirer.prompt(agentTypeQuestion)) as Pick<
    AIAgentCreationAnswers,
    "agentType"
  >;

  // Then ask for name
  const nameQuestion = [
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
  ];

  // @ts-expect-error - inquirer types are not matching correctly
  const nameAnswer = (await inquirer.prompt(nameQuestion)) as Pick<AIAgentCreationAnswers, "name">;

  // ask for description only if agent type is "default"
  let descriptionAnswer: Pick<AIAgentCreationAnswers, "description"> = {};
  if (agentTypeAnswer.agentType === "default") {
    const descriptionQuestion = [
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
    ];

    // @ts-expect-error - inquirer types are not matching correctly
    descriptionAnswer = (await inquirer.prompt(descriptionQuestion)) as Pick<
      AIAgentCreationAnswers,
      "description"
    >;
  }

  // Ask for provider
  const providerQuestion = [
    {
      type: "list",
      name: "llmProvider",
      message: "Which LLM provider would you like to use?",
      choices: providers.map((p) => ({
        name: p.name,
        value: p.name,
        disabled: p.configured ? false : "- API key not configured",
      })),
      default: providers.find((p) => p.configured)?.name,
    },
  ];

  // @ts-expect-error - inquirer types are not matching correctly
  const providerAnswer = (await inquirer.prompt(providerQuestion)) as Pick<
    AIAgentCreationAnswers,
    "llmProvider"
  >;

  // Combine answers so far
  const basicAnswers = {
    ...agentTypeAnswer,
    ...nameAnswer,
    ...descriptionAnswer,
    ...providerAnswer,
  };

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

  // Check if this is a predefined agent with auto-assigned tools
  const currentPredefinedAgent = PREDEFINED_AGENTS[basicAnswers.agentType];
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
              { name: "Low - Faster responses, basic reasoning", value: "low" },
              {
                name: "Medium - Balanced speed and reasoning depth (recommended)",
                value: "medium",
              },
              { name: "High - Deep reasoning, slower responses", value: "high" },
              { name: "Disable - No reasoning effort (fastest)", value: "disable" },
            ],
          },
        ]
      : []),
    // Skip tool selection for predefined agents (already auto-selected)
    ...(!PREDEFINED_AGENTS[basicAnswers.agentType]
      ? [
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
        ]
      : []),
  ];

  // @ts-expect-error - inquirer types are not matching correctly
  const finalAnswers = (await inquirer.prompt(finalQuestions)) as Pick<
    AIAgentCreationAnswers,
    "llmModel" | "reasoningEffort" | "tools"
  >;

  // Combine all answers
  // For predefined agents, convert category IDs back to display names for the answer
  const predefinedAgent = PREDEFINED_AGENTS[basicAnswers.agentType];
  const finalTools = predefinedAgent
    ? predefinedAgent.toolCategoryIds
        .map((id) => categoryIdToDisplayName.get(id))
        .filter((name): name is string => name !== undefined && name in toolsByCategory)
    : finalAnswers.tools || [];

  return {
    ...basicAnswers,
    ...finalAnswers,
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
  | TerminalService
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
  ToolRegistry | TerminalService
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
        yield* terminal.log("   /new     - Start a new conversation (clear context)");
        yield* terminal.log("   /status  - Show current conversation status");
        yield* terminal.log("   /tools   - List all available tools by category");
        yield* terminal.log("   /edit    - Edit this agent's configuration");
        yield* terminal.log("   /clear   - Clear the screen");
        yield* terminal.log("   /help    - Show this help message");
        yield* terminal.log("   /exit    - Exit the chat");
        yield* terminal.log("");
        return { shouldContinue: true };

      case "status": {
        yield* terminal.heading("📊 Conversation Status");
        yield* terminal.log(`   Agent: ${agent.name} (${agent.id})`);
        yield* terminal.log(`   Conversation ID: ${conversationId || "Not started"}`);
        yield* terminal.log(`   Messages in history: ${conversationHistory.length}`);
        yield* terminal.log(`   Agent type: ${agent.config.agentType}`);
        yield* terminal.log(`   LLM: ${agent.config.llmProvider}/${agent.config.llmModel}`);
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
): Effect.Effect<
  void,
  Error,
  | ConfigService
  | LLMService
  | ToolRegistry
  | LoggerService
  | FileSystemContextService
  | FileSystem.FileSystem
  | TerminalService
> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    let chatActive = true;
    let conversationId: string | undefined;
    let conversationHistory: ChatMessage[] = [];
    let sessionInitialized = false;

    while (chatActive) {
      // Prompt for user input
      const answer = yield* Effect.promise(() =>
        inquirer
          .prompt([
            {
              type: "input",
              name: "message",
              message: "You:",
            },
          ])
          .catch((error: unknown) => {
            // Handle ExitPromptError from inquirer when user presses Ctrl+C
            if (
              error instanceof Error &&
              (error.name === "ExitPromptError" || error.message.includes("SIGINT"))
            ) {
              // Exit gracefully on Ctrl+C - return /exit to trigger normal exit flow
              // The exit check below will handle the goodbye message
              return Promise.resolve({ message: "/exit" });
            }
            // Re-throw other errors, ensuring it's an Error instance
            return Promise.reject(error instanceof Error ? error : new Error(String(error)));
          }),
      );

      const userMessage = answer.message as string;

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
