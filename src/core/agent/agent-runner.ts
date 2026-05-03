import { Effect, Option } from "effect";
import { DEFAULT_MAX_LLM_RETRIES } from "@/core/constants/agent";
import type { ProviderName } from "@/core/constants/models";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
import type { LLMService } from "@/core/interfaces/llm";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import { type MCPServerManager } from "@/core/interfaces/mcp-server";
import { PersonaServiceTag, type PersonaService } from "@/core/interfaces/persona-service";
import { type PresentationService } from "@/core/interfaces/presentation";
import type { TerminalService } from "@/core/interfaces/terminal";
import {
  ToolRegistryTag,
  type ToolRegistry,
  type ToolRequirements,
} from "@/core/interfaces/tool-registry";
import {
  matchSkillTriggers,
  SkillServiceTag,
  type SkillService,
} from "@/core/skills/skill-service";
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
import {
  BUILTIN_TOOL_CATEGORIES,
  registerMCPToolsForAgent,
  registerSkillSystemTools,
} from "./tools/register-tools";
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
  | PresentationService
> {
  return Effect.gen(function* () {
    const { agent, userInput, conversationId } = options;
    const toolRegistry = yield* ToolRegistryTag;
    const skillService = yield* SkillServiceTag;
    const configService = yield* AgentConfigServiceTag;
    const appConfig = yield* configService.appConfig;

    const actualConversationId = conversationId || `${Date.now()}`;
    const history: ChatMessage[] = options.conversationHistory || [];
    const persona = agent.config.persona;
    const provider: ProviderName = agent.config.llmProvider;
    const model = agent.config.llmModel;

    // Resolve persona service early so we can read the persona's tool profile
    // before building the tool set. Falls back gracefully if the service is
    // not provided (e.g. some test layers omit it).
    const personaServiceOption = yield* Effect.serviceOption(PersonaServiceTag);
    const resolvedPersonaService: PersonaService | undefined = Option.isSome(personaServiceOption)
      ? personaServiceOption.value
      : undefined;
    const resolvedPersona = resolvedPersonaService
      ? yield* resolvedPersonaService
          .getPersonaByIdentifier(persona)
          .pipe(Effect.catchAll(() => Effect.succeed(null)))
      : null;
    const toolProfile = resolvedPersona?.toolProfile;

    const runMetrics = createAgentRunMetrics({
      agent,
      conversationId: actualConversationId,
      provider,
      model,
      reasoningEffort: agent.config.reasoningEffort ?? "disable",
      maxIterations: options.maxIterations,
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

    // Resolve which built-in categories the persona wants. Default = all of
    // BUILTIN_TOOL_CATEGORIES (current behavior). If toolProfile.categories is
    // explicitly an empty array, no built-in tools are included (replaces the
    // legacy `persona === "summarizer" ? []` carve-out).
    const requestedBuiltinCategoryIds: readonly string[] = (() => {
      if (toolProfile?.categories !== undefined) return toolProfile.categories;
      // Back-compat: summarizer with no profile keeps its empty bundle.
      if (persona === "summarizer") return [];
      return BUILTIN_TOOL_CATEGORIES.map((c) => c.id);
    })();

    const validBuiltinCategoryIds = new Set(BUILTIN_TOOL_CATEGORIES.map((c) => c.id));
    const builtInToolNames = (yield* Effect.all(
      requestedBuiltinCategoryIds
        .filter((id) => validBuiltinCategoryIds.has(id))
        .map((id) => toolRegistry.getToolsInCategory(id)),
    )).flat();

    // Combine agent tools with built-in tools, then apply persona deny list.
    let combinedToolNames = [...new Set([...agentToolNames, ...builtInToolNames])];

    if (toolProfile?.deny && toolProfile.deny.length > 0) {
      const denied = new Set(toolProfile.deny);
      combinedToolNames = combinedToolNames.filter((name) => !denied.has(name));
    }

    // Filter out any non-existent tools silently — tools may have been removed
    // or MCP servers may be unavailable. The agent can still operate with its
    // remaining tools.
    const allToolNames = yield* toolRegistry.listAllTools();
    combinedToolNames = combinedToolNames.filter((toolName) => allToolNames.includes(toolName));

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

    // Pre-router: scan the user input for skill triggers. Skills whose
    // `triggers` frontmatter list contains a substring of the input have
    // their full description auto-injected into this turn's system prompt.
    // Deterministic, zero LLM overhead, predictable for skill authors.
    const triggeredSkillNames = matchSkillTriggers(userInput, relevantSkills);

    // Build messages — reuses the PersonaService resolved earlier so custom
    // personas can be looked up by name when assembling the system prompt.
    const messages: ConversationMessages = yield* agentPromptBuilder.buildAgentMessages(
      persona,
      {
        agentName: agent.name,
        agentDescription: agent.description || "",
        userInput,
        conversationHistory: history,
        toolNames: expandedToolNames,
        availableTools,
        knownSkills: relevantSkills,
        ...(triggeredSkillNames.length > 0 && { triggeredSkillNames }),
      },
      resolvedPersonaService,
    );

    // Always provide mutable arrays for session-level approvals.
    // If the caller provided arrays (e.g. from chat-service or parent agent),
    // use them directly (by reference) so mutations propagate back.
    // Otherwise create local arrays so approvals still persist within this run.
    const autoApprovedCommands: string[] = options.autoApprovedCommands
      ? (options.autoApprovedCommands as string[])
      : [];
    const autoApprovedTools: string[] = options.autoApprovedTools
      ? (options.autoApprovedTools as string[])
      : [];

    const toolContext: ToolExecutionContext = {
      agentId: agent.id,
      sessionId: options.sessionId,
      conversationId: actualConversationId,
      model,
      ...(options.autoApprovePolicy !== undefined
        ? { autoApprovePolicy: options.autoApprovePolicy }
        : {}),
      // Always pass arrays by reference so that in-place mutations via
      // onAutoApproveCommand/onAutoApproveTool callbacks are visible to
      // subsequent isAutoApproved checks within the same agent run.
      autoApprovedCommands,
      autoApprovedTools,
      onAutoApproveCommand:
        options.onAutoApproveCommand ??
        ((command: string) =>
          Effect.sync(() => {
            if (!autoApprovedCommands.includes(command)) {
              autoApprovedCommands.push(command);
            }
          })),
      onAutoApproveTool:
        options.onAutoApproveTool ??
        ((toolName: string) => {
          if (!autoApprovedTools.includes(toolName)) {
            autoApprovedTools.push(toolName);
          }
        }),
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
      maxRetries: Math.max(0, Math.floor(appConfig.maxRetries ?? DEFAULT_MAX_LLM_RETRIES)),
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
      const appConfig = yield* configService.appConfig;

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
        maxIterations?: number;
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
      maxIterations?: number;
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
