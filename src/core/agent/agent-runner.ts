import { Effect } from "effect";
import { MAX_AGENT_STEPS } from "@/core/constants/agent";
import type { ProviderName } from "@/core/constants/models";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
import type { LLMService } from "@/core/interfaces/llm";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import { type MCPServerManager } from "@/core/interfaces/mcp-server";
import { PresentationServiceTag, type PresentationService } from "@/core/interfaces/presentation";
import type { TerminalService } from "@/core/interfaces/terminal";
import {
  ToolRegistryTag,
  type ToolRegistry,
  type ToolRequirements,
} from "@/core/interfaces/tool-registry";
import { SkillServiceTag, type SkillService } from "@/core/skills/skill-service";
import { LLMRateLimitError } from "@/core/types/errors";
import type { ChatMessage } from "@/core/types/message";
import type { DisplayConfig } from "@/core/types/output";
import type { ToolExecutionContext } from "@/core/types/tools";
import { resolveDisplayConfig } from "@/core/utils/display-config";
import { shouldEnableStreaming } from "@/core/utils/stream-detector";
import type { ConversationMessages, StreamingConfig } from "../types";
import { type Agent } from "../types";
import { agentPromptBuilder } from "./agent-prompt";
import { Summarizer } from "./context/summarizer";
import { executeWithStreaming, executeWithoutStreaming } from "./execution";
import { createAgentRunMetrics } from "./metrics/agent-run-metrics";
import { registerMCPToolsForAgent, registerSkillSystemTools } from "./tools/register-tools";
import { type AgentResponse, type AgentRunContext, type AgentRunnerOptions } from "./types";
import { normalizeToolConfig } from "./utils/tool-config";

/**
 * Initialize common agent run context (tools, messages, metrics)
 */
function initializeAgentRun(
  options: AgentRunnerOptions,
): Effect.Effect<
  AgentRunContext,
  Error,
  | ToolRegistry
  | LoggerService
  | AgentConfigService
  | MCPServerManager
  | TerminalService
  | SkillService
> {
  return Effect.gen(function* () {
    const { agent, userInput, conversationId } = options;
    const toolRegistry = yield* ToolRegistryTag;
    const skillService = yield* SkillServiceTag;

    const actualConversationId = conversationId || `${Date.now()}`;
    const history: ChatMessage[] = options.conversationHistory || [];
    const agentType = agent.config.agentType;
    const provider: ProviderName = agent.config.llmProvider;
    const model = agent.config.llmModel;

    const runMetrics = createAgentRunMetrics({
      agent,
      conversationId: actualConversationId,
      provider,
      model,
      reasoningEffort: agent.config.reasoningEffort ?? "disable",
      maxIterations: options.maxIterations ?? MAX_AGENT_STEPS,
    });

    // Level 1: List all available skills (metadata only)
    const relevantSkills = yield* skillService.listSkills();
    const logger = yield* LoggerServiceTag;
    yield* logger.debug(
      `[Skills] Discovered ${relevantSkills.length} skills: ${relevantSkills.map((s) => s.name).join(", ")}`,
    );

    // Register skill tools with discovered skill names as enum constraint
    yield* registerSkillSystemTools(relevantSkills.map((s) => s.name));

    // Get agent's tool names
    const agentToolNames = normalizeToolConfig(agent.config.tools, {
      agentId: agent.id,
    });

    // Register MCP tools for this agent if needed (only connects to relevant servers)
    // This happens before validation so MCP tools are available
    const connectedMCPServers = yield* registerMCPToolsForAgent(agentToolNames).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          const logger = yield* LoggerServiceTag;
          const errorMessage = error instanceof Error ? error.message : String(error);
          yield* logger.warn(`Failed to register MCP tools for agent: ${errorMessage}`);
          // Continue even if MCP registration fails - tools might not be needed
          return [];
        }),
      ),
    );

    // Always include skill tools and user interaction tools so agents can use them by default
    const BUILT_IN_TOOLS = [
      "load_skill",
      "load_skill_section",
      "ask_user_question",
      "ask_file_picker",
      "spawn_subagent",
      "summarize_context",
    ];

    // Combine agent tools with skill tools (skill tools always available)
    const combinedToolNames = [...new Set([...agentToolNames, ...BUILT_IN_TOOLS])];

    // Get and validate tools (after MCP tools are registered)
    // Use listAllTools to include hidden builtin tools like ask_user
    const allToolNames = yield* toolRegistry.listAllTools();
    const invalidTools = combinedToolNames.filter((toolName) => !allToolNames.includes(toolName));
    if (invalidTools.length > 0) {
      const toolList = invalidTools.join(", ");
      const errorMessage = [
        `Agent "${agent.name}" (${agent.id}) references non-existent tools: ${toolList}`,
        ``,
        `Possible reasons:`,
        `  • The app needs to be restarted after adding new tools`,
        `  • Tool names are misspelled in the agent configuration`,
        `  • Required MCP servers are not configured or failed to connect`,
      ].join("\n");

      return yield* Effect.fail(new Error(errorMessage));
    }

    // Expand tool names to include approval execute tools
    const expandedToolNameSet = new Set(combinedToolNames);
    for (const toolName of combinedToolNames) {
      const tool = yield* toolRegistry.getTool(toolName);
      if (tool.approvalExecuteToolName) {
        expandedToolNameSet.add(tool.approvalExecuteToolName);
      }
    }

    const expandedToolNames = Array.from(expandedToolNameSet);
    const allTools = yield* toolRegistry.getToolDefinitions();
    const tools = Array.from(
      allTools.filter((tool) => expandedToolNames.includes(tool.function.name)),
    );

    // Build tool descriptions map
    const availableTools: Record<string, string> = {};
    for (const tool of tools) {
      availableTools[tool.function.name] = tool.function.description;
    }

    // Build messages
    const messages: ConversationMessages = yield* agentPromptBuilder.buildAgentMessages(agentType, {
      agentName: agent.name,
      agentDescription: agent.description || "",
      userInput,
      conversationHistory: history,
      toolNames: expandedToolNames,
      availableTools,
      knownSkills: relevantSkills,
    });

    const toolContext: ToolExecutionContext = {
      agentId: agent.id,
      sessionId: options.sessionId,
      conversationId: actualConversationId,
      ...(options.autoApprovePolicy !== undefined
        ? { autoApprovePolicy: options.autoApprovePolicy }
        : {}),
      ...(options.autoApprovedCommands?.length
        ? { autoApprovedCommands: options.autoApprovedCommands }
        : {}),
      ...(options.onAutoApproveCommand
        ? { onAutoApproveCommand: options.onAutoApproveCommand }
        : {}),
      ...(options.autoApprovedTools?.length
        ? { autoApprovedTools: options.autoApprovedTools }
        : {}),
      ...(options.onAutoApproveTool ? { onAutoApproveTool: options.onAutoApproveTool } : {}),
    };

    return {
      agent,
      actualConversationId,
      context: toolContext,
      tools,
      expandedToolNames,
      messages,
      runMetrics,
      provider,
      model,
      connectedMCPServers,
      knownSkills: relevantSkills,
    };
  });
}

/**
 * Agent runner for executing agent conversations.
 *
 * This class serves as the orchestrator for agent execution, delegating to
 * specialized executors for streaming vs batch mode, and managing context
 * initialization and cleanup.
 */
export class AgentRunner {
  /**
   * Internal execution mode for sub-agents (e.g., summarizers, researchers).
   * Does not trigger UI events like thinking indicators or incremental rendering.
   */
  public static runRecursive(
    options: Omit<AgentRunnerOptions, "internal">,
  ): Effect.Effect<
    AgentResponse,
    Error,
    | LLMService
    | ToolRegistry
    | LoggerService
    | AgentConfigService
    | PresentationService
    | ToolRequirements
    | SkillService
  > {
    return AgentRunner.run({ ...options, internal: true });
  }

  /**
   * Run an agent conversation.
   *
   * This is the main entry point for executing agent conversations.
   * It automatically selects streaming or batch mode based on configuration.
   */
  static run(
    options: AgentRunnerOptions,
  ): Effect.Effect<
    AgentResponse,
    LLMRateLimitError | Error,
    | LLMService
    | ToolRegistry
    | LoggerService
    | AgentConfigService
    | PresentationService
    | ToolRequirements
    | SkillService
  > {
    return Effect.gen(function* () {
      // Get services
      const configService = yield* AgentConfigServiceTag;
      const presentationService = yield* PresentationServiceTag;
      const appConfig = yield* configService.appConfig;

      // Show thinking indicator immediately to provide instant feedback
      if (!options.internal) {
        yield* presentationService.presentThinking(options.agent.name, true);
      }

      // Initialize run context
      const runContext = yield* initializeAgentRun(options);

      // Determine if streaming should be enabled
      // Internal runs (sub-agents) use the same streaming detection as the parent
      // to ensure provider-native tools (e.g., OpenAI web search) work correctly.
      // Batch mode cannot reliably handle provider-native tool calls.
      const streamDetection = shouldEnableStreaming(
        appConfig,
        options.stream !== undefined ? { stream: options.stream } : {},
      );

      // Get display config with defaults
      const displayConfig: DisplayConfig = resolveDisplayConfig(appConfig);

      // Check if we should show metrics
      const showMetrics = appConfig.output?.showMetrics ?? true;

      // Get streaming config with defaults (streaming-specific)
      const streamingConfig: StreamingConfig = {
        ...(appConfig.output?.streaming?.enabled !== undefined
          ? { enabled: appConfig.output.streaming.enabled }
          : {}),
        ...(appConfig.output?.streaming?.textBufferMs !== undefined
          ? { textBufferMs: appConfig.output.streaming.textBufferMs }
          : {}),
      };

      const runRecursive = (runOpts: {
        agent: Agent;
        userInput: string;
        sessionId: string;
        conversationId: string;
        maxIterations: number;
      }) => AgentRunner.runRecursive(runOpts);

      if (streamDetection.shouldStream) {
        return yield* executeWithStreaming(
          options,
          runContext,
          displayConfig,
          streamingConfig,
          showMetrics,
          runRecursive,
        );
      } else {
        return yield* executeWithoutStreaming(
          options,
          runContext,
          displayConfig,
          showMetrics,
          runRecursive,
        );
      }
    });
  }

  /**
   * Summarizes a portion of the conversation history using a specialized sub-agent.
   * Returns a single assistant message containing the summary.
   *
   * This is a public convenience method that delegates to the Summarizer module.
   */
  public static summarizeHistory(
    messagesToSummarize: ChatMessage[],
    agent: Agent,
    sessionId: string,
    conversationId: string,
  ): Effect.Effect<
    ChatMessage,
    Error,
    | LLMService
    | ToolRegistry
    | LoggerService
    | AgentConfigService
    | PresentationService
    | ToolRequirements
    | SkillService
  > {
    const runRecursive = (runOpts: {
      agent: Agent;
      userInput: string;
      sessionId: string;
      conversationId: string;
      maxIterations: number;
    }) => AgentRunner.runRecursive(runOpts);

    return Summarizer.summarizeHistory(
      messagesToSummarize,
      agent,
      sessionId,
      conversationId,
      runRecursive,
    );
  }
}

// Re-export types for convenience
export type { AgentResponse, AgentRunContext, AgentRunnerOptions } from "./types";
