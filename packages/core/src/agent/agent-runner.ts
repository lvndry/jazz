/**
 * `AgentRunner`: top-level entry point that resolves an agent's config, LLM, and
 * tool registry, then drives one conversation turn through the batch or streaming
 * executor depending on the model's capabilities.
 */

import { FileSystem } from "@effect/platform";
import { Cause, Effect, Option, Scope } from "effect";
import {
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MAX_LLM_RETRIES,
  DEFAULT_MAX_SUBAGENT_DEPTH,
  DEFAULT_MAX_SUBAGENT_ITERATIONS,
} from "@/core/constants/agent";
import { isLocalServerProvider } from "@/core/constants/local-providers";
import { DEFAULT_MEMORY_SCOPE } from "@/core/constants/memory";
import type { ProviderName } from "@/core/constants/models";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
import { FileSystemContextServiceTag } from "@/core/interfaces/fs";
import {
  LLMServiceTag,
  type LLMService,
  type LlamaCppServerModel,
  type OllamaShowExtras,
  type SglangServerModel,
  type VllmServerModel,
} from "@/core/interfaces/llm";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import { type MCPServerManager } from "@/core/interfaces/mcp-server";
import { MemoryServiceTag } from "@/core/interfaces/memory-service";
import { PersonaServiceTag, type PersonaService } from "@/core/interfaces/persona-service";
import { PluginRuntimeServiceTag } from "@/core/interfaces/plugin-runtime";
import { type PresentationService } from "@/core/interfaces/presentation";
import type { TelemetryTraceParent } from "@/core/interfaces/telemetry";
import type { TerminalService } from "@/core/interfaces/terminal";
import {
  ToolRegistryTag,
  type ToolRegistry,
  type ToolRequirements,
} from "@/core/interfaces/tool-registry";
import type { ActivePreference } from "@/core/memory/preference-line";
import { collectMemorySources } from "@/core/memory/source-trust";
import { resolveDisplayConfig } from "@/core/presentation/display-config";
import { SkillServiceTag, type SkillService } from "@/core/skills/skill-service";
import type { AttachmentKind } from "@/core/types/attachment";
import type { LLMConfig } from "@/core/types/config";
import { LLMRateLimitError } from "@/core/types/errors";
import type { ChatMessage, MemorySource } from "@/core/types/message";
import type { DisplayConfig } from "@/core/types/output";
import {
  DEFAULT_PLUGIN_HOOK_TIMEOUT_MS,
  type SkillRouteOutcome,
  type WorkspaceContextInput,
} from "@/core/types/plugin";
import type { AutoApprovePolicy, ToolExecutionContext } from "@/core/types/tools";
import { generateConversationId } from "@/core/utils/conversation-id";
import { getModelsDevMetadata } from "@/core/utils/models-dev";
import { resolveOllamaAttachmentSupport } from "@/core/utils/ollama-attachment-support";
import { shouldEnableStreaming } from "@/core/utils/stream-detector";
import type { ConversationMessages, StreamingConfig } from "../types";
import { type Agent } from "../types";
import { agentPromptBuilder } from "./agent-prompt";
import { buildAdvisedReducer } from "./context/advised-tool-clearing";
import {
  Summarizer,
  type CompactionOutcome,
  type CompactionProgressObserver,
  type RecursiveRunner,
} from "./context/summarizer";
import { assertConversationWritable } from "./detach/ownership";
import { executeWithStreaming, executeWithoutStreaming } from "./execution";
import { createMemoryOpportunityRecorder } from "./memory-opportunity-recorder";
import { MANAGE_MEMORY_TOOL_NAME, VIEW_MEMORY_TOOL_NAME } from "./memory-recall-log";
import {
  createAgentRunMetrics,
  emitAgentRunStarted,
  telemetryErrorCategory,
} from "./metrics/agent-run-metrics";
import { discoverProjectInstructions, type ProjectInstructionFile } from "./project-instructions";
import { withRunRecording } from "./run/run-recorder";
import { runSpendUSD } from "./run/run-spend";
import { toolDenials } from "./tools/agent-tool-resolution";
import { resolveCommandRisk } from "./tools/command-risk";
import { registerCustomToolsForAgent } from "./tools/custom-tools";
import { registerMCPToolsForAgent } from "./tools/register-mcp-tools";
import { registerPluginToolsForAgent } from "./tools/register-plugin-tools";
import { registerPeerTools } from "./tools/register-tools";
import { registerSkillSystemTools } from "./tools/register-tools";
import { BUILTIN_TOOL_CATEGORIES } from "./tools/tool-categories";
import { type AgentResponse, type AgentRunContext, type AgentRunnerOptions } from "./types";
import { normalizeToolConfig } from "./utils/tool-config";

/**
 * Resolve the AGENTS.md files that apply to this run.
 *
 * The working directory is read from FileSystemContextService when it is in the
 * environment — that is the directory the agent's own file tools operate on, so
 * it stays correct after the agent changes directories — and falls back to the
 * process cwd for surfaces (and tests) that do not provide the service.
 */
/**
 * Attachment modalities this agent's model accepts, from the models.dev catalog.
 *
 * Returns nothing on a catalog miss rather than assuming capability. Unlike tool support — which
 * defaults to available so an unrecognized model is not needlessly crippled — sending media to a
 * model without that input is a hard provider error, so an unknown model is treated as
 * text-only. The known cost is locally-served models: ollama and llama.cpp are largely absent
 * from the catalog, so a capable local VLM reads as text-only here.
 */
/**
 * Whether this agent's model produces media of any kind.
 *
 * Unknown models count as "cannot", matching every other capability check here: the consequence
 * of guessing wrong is an agent that promises an image it cannot make.
 */
/**
 * Reads the entries that apply to every turn (`always/`).
 *
 * Injected rather than looked up: recall that depends on the model choosing to
 * spend a tool call is recall it will sometimes skip, and a preference the user
 * already stated is not something they should have to restate. Topic-scoped
 * entries are the agent's responsibility to discover via `view_memory`.
 *
 * Memory is optional — an agent configured without it still runs — and a failure
 * to read degrades to injecting nothing rather than failing the run.
 */
function resolveActivePreferences(
  memoryScopes: readonly string[],
  logger: LoggerService,
): Effect.Effect<readonly ActivePreference[], never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const memoryServiceOption = yield* Effect.serviceOption(MemoryServiceTag);
    if (Option.isNone(memoryServiceOption)) {
      yield* logger.debug("No memory service in context; skipping memory injection");
      return [];
    }
    const memoryService = memoryServiceOption.value;
    return yield* Effect.gen(function* () {
      const standingEntries = yield* memoryService.standingEntries(memoryScopes);
      return standingEntries.map((entry) => ({
        scope: entry.scope,
        summary: entry.summary,
      }));
    }).pipe(
      Effect.catchAll((error) =>
        logger
          .warn("Failed to read memory; running without it", {
            scopeCount: memoryScopes.length,
            errorCategory: telemetryErrorCategory(error),
          })
          .pipe(Effect.as<readonly ActivePreference[]>([])),
      ),
    );
  });
}

function resolveCanGenerateMedia(
  agent: AgentRunnerOptions["agent"],
): Effect.Effect<boolean, never> {
  return Effect.gen(function* () {
    const metadata = yield* Effect.tryPromise({
      try: () => getModelsDevMetadata(agent.config.llmModel, agent.config.llmProvider),
      catch: (error) => error,
    }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
    if (metadata === undefined) return false;

    return metadata.generatesImage || metadata.generatesAudio || metadata.generatesVideo;
  });
}

function resolveSupportedAttachmentKinds(
  agent: AgentRunnerOptions["agent"],
): Effect.Effect<readonly AttachmentKind[], never, LLMService> {
  return Effect.gen(function* () {
    const metadata = yield* Effect.tryPromise({
      try: () => getModelsDevMetadata(agent.config.llmModel, agent.config.llmProvider),
      catch: (error) => error,
    }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));

    // Ollama reports the capabilities of the model file actually on this host, which the
    // catalog usually knows nothing about — most local tags are absent from models.dev
    // entirely. Without this, a local multimodal model reads as text-only and jazz refuses to
    // send it an image it can read perfectly well.
    if (agent.config.llmProvider === "ollama") {
      const llmService = yield* LLMServiceTag;
      const baseUrl = llmService.resolveLocalProviderBaseUrl("ollama", undefined);
      const extras = yield* llmService
        .fetchOllamaModelDetails(baseUrl, agent.config.llmModel)
        .pipe(Effect.catchAll(() => Effect.succeed<OllamaShowExtras>({})));

      // Today this only ever yields "image" — the provider cannot transport anything else — but
      // the mapping stays exhaustive so widening it is a one-line change in one place.
      const support = resolveOllamaAttachmentSupport(extras.capabilities, metadata);
      const localKinds: AttachmentKind[] = [];
      if (support.ingestImage) localKinds.push("image");
      if (support.ingestPdf) localKinds.push("pdf");
      if (support.ingestAudio) localKinds.push("audio");
      return localKinds;
    }

    if (metadata === undefined) return [];

    const kinds: AttachmentKind[] = [];
    if (metadata.ingestImage) kinds.push("image");
    if (metadata.ingestPdf) kinds.push("pdf");
    if (metadata.ingestAudio) kinds.push("audio");
    if (metadata.ingestVideo) kinds.push("video");
    return kinds;
  });
}

/**
 * Ask a llama.cpp server what it is actually serving for this run.
 *
 * A bare llama-server serves whatever model was loaded at launch, ignoring the requested name,
 * and that can change between runs. So the model id stored on the agent is only a hint: read the
 * live model and context window from the server instead. Any failure (server down, endpoint
 * missing) resolves to an empty result and the caller keeps the stored values — this must never
 * fail the run.
 */
export function resolveLlamaCppServerModel(
  llmConfig?: LLMConfig,
): Effect.Effect<LlamaCppServerModel, never, LLMService> {
  return Effect.gen(function* () {
    const llmService = yield* LLMServiceTag;
    const baseUrl = llmService.resolveLocalProviderBaseUrl("llamacpp", llmConfig);
    return yield* llmService
      .fetchLlamaCppServerModel(baseUrl, llmConfig?.llamacpp?.api_key)
      .pipe(Effect.catchAll(() => Effect.succeed<LlamaCppServerModel>({})));
  });
}

/**
 * Read the model vLLM is serving at run start and its context limit.
 *
 * A server can change between runs. Keep the configured ID if still advertised; otherwise
 * use the first served entry. A failed lookup leaves the saved model and context estimate
 * in place so the server can still handle the request or report an explicit error.
 */
export function resolveVllmServerModel(
  preferredModelId: string,
  llmConfig?: LLMConfig,
): Effect.Effect<VllmServerModel, never, LLMService> {
  return Effect.gen(function* () {
    const llmService = yield* LLMServiceTag;
    const baseUrl = llmService.resolveLocalProviderBaseUrl("vllm", llmConfig);
    return yield* llmService
      .fetchVllmServerModel(baseUrl, preferredModelId, llmConfig?.vllm?.api_key)
      .pipe(Effect.catchAll(() => Effect.succeed<VllmServerModel>({})));
  });
}

/** Refresh SGLang's served ID and context at each run; keep saved values if lookup fails. */
export function resolveSglangServerModel(
  preferredModelId: string,
  llmConfig?: LLMConfig,
): Effect.Effect<SglangServerModel, never, LLMService> {
  return Effect.gen(function* () {
    const llmService = yield* LLMServiceTag;
    const baseUrl = llmService.resolveLocalProviderBaseUrl("sglang", llmConfig);
    return yield* llmService
      .fetchSglangServerModel(baseUrl, preferredModelId, llmConfig?.sglang?.api_key)
      .pipe(Effect.catchAll(() => Effect.succeed<SglangServerModel>({})));
  });
}

/**
 * The agent's tracked working directory, or the process cwd when no filesystem context exists.
 *
 * The agent can `cd` mid-session, so this is not the same as `process.cwd()` — which matters
 * for anything resolving a relative path the user typed.
 */
function resolveAgentWorkingDirectory(
  agentId: string,
  options: AgentRunnerOptions,
): Effect.Effect<string, never> {
  return Effect.gen(function* () {
    const fileSystemContextOption = yield* Effect.serviceOption(FileSystemContextServiceTag);
    if (!Option.isSome(fileSystemContextOption)) return process.cwd();
    return yield* fileSystemContextOption.value.getCwd({
      agentId,
      ...(options.conversationId !== undefined ? { conversationId: options.conversationId } : {}),
    });
  });
}

function resolveProjectInstructions(
  persona: string,
  agentId: string,
  options: AgentRunnerOptions,
): Effect.Effect<readonly ProjectInstructionFile[], never> {
  return Effect.gen(function* () {
    if (persona === "summarizer") return [];

    const workingDirectory = yield* resolveAgentWorkingDirectory(agentId, options);
    return yield* Effect.sync(() => discoverProjectInstructions(workingDirectory));
  });
}

/**
 * Resolve a `maxCostUSD`/`maxTokens`-style cap: unlike `maxIterations`, neither has a
 * default ceiling, so an unset or non-positive value means uncapped rather than falling
 * back to a constant.
 */
function resolvePositiveCap(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Convert a validated routing distribution into the only text the conversation model sees.
 * Plugin-authored prose is intentionally excluded; the selected name must come from the live roster.
 */
export function renderSkillRoutingAdvisory(
  outcome: SkillRouteOutcome,
  liveSkillNames: ReadonlySet<string>,
): string | undefined {
  if (outcome.status !== "answered") return undefined;
  const best = [...outcome.distribution.skills]
    .filter((choice) => liveSkillNames.has(choice.name))
    .sort((left, right) => right.probability - left.probability)[0];
  if (best === undefined || best.probability <= outcome.distribution.noSkillProbability) {
    return undefined;
  }
  return `[Skill routing advisory: consider loading ${JSON.stringify(best.name)} before answering. This is a non-authoritative relevance hint with probability ${best.probability.toFixed(3)}.]`;
}

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
  | LLMService
  | FileSystem.FileSystem
  | Scope.Scope
> {
  return Effect.gen(function* () {
    const { agent, userInput, conversationId } = options;
    const toolRegistry = yield* ToolRegistryTag;
    const skillService = yield* SkillServiceTag;
    const configService = yield* AgentConfigServiceTag;
    const appConfig = yield* configService.appConfig;

    const actualConversationId = conversationId || generateConversationId();
    const history: ChatMessage[] = options.conversationHistory || [];
    const persona = agent.config.persona;
    const provider: ProviderName = agent.config.llmProvider;
    // Local servers can change models between runs. The live model and window flow into
    // metrics, the footer, and context accounting; the saved ID is a fallback.
    const servedLlamaCppModel =
      provider === "llamacpp" ? yield* resolveLlamaCppServerModel(appConfig.llm) : undefined;
    const servedVllmModel =
      provider === "vllm"
        ? yield* resolveVllmServerModel(agent.config.llmModel, appConfig.llm)
        : undefined;
    const servedSglangModel =
      provider === "sglang"
        ? yield* resolveSglangServerModel(agent.config.llmModel, appConfig.llm)
        : undefined;
    const model =
      servedLlamaCppModel?.modelId ??
      servedVllmModel?.modelId ??
      servedSglangModel?.modelId ??
      agent.config.llmModel;
    const serverContextWindow =
      servedLlamaCppModel?.contextWindow ??
      servedVllmModel?.contextWindow ??
      servedSglangModel?.contextWindow;

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

    const resolvedMaxIterations = Math.max(
      1,
      Math.floor(options.maxIterations ?? appConfig.maxIterations ?? DEFAULT_MAX_ITERATIONS),
    );
    // No default ceiling for either — unset at both the call site and app config means
    // uncapped, unlike maxIterations which always falls back to DEFAULT_MAX_ITERATIONS.
    const resolvedMaxCostUSD = resolvePositiveCap(options.maxCostUSD ?? appConfig.maxCostUSD);
    const resolvedMaxTokens = resolvePositiveCap(options.maxTokens ?? appConfig.maxTokens);
    const resolvedMaxDurationMs = resolvePositiveCap(
      options.maxDurationMs ?? appConfig.maxDurationMs,
    );

    const runMetrics = createAgentRunMetrics({
      agent,
      conversationId: actualConversationId,
      ...(options.telemetryParent ? { telemetryParent: options.telemetryParent } : {}),
      provider,
      model,
      reasoningEffort: agent.config.reasoning ?? "disable",
      maxIterations: resolvedMaxIterations,
      maxCostUSD: resolvedMaxCostUSD,
    });

    yield* emitAgentRunStarted(runMetrics);

    // Level 1: List all available skills (metadata only)
    const relevantSkills = yield* skillService.listSkills();
    const logger = yield* LoggerServiceTag;
    yield* logger.debug("Skills discovered", { count: relevantSkills.length });

    // One plugin session owns every hook/provider registration for this run. It remains alive
    // through tool execution so policy hooks and routing share the same bounded budgets and is
    // released by the enclosing Effect scope on success, failure, or interruption.
    const pluginRuntime = yield* Effect.serviceOption(PluginRuntimeServiceTag);
    const pluginSession =
      options.internal !== true && persona !== "summarizer" && Option.isSome(pluginRuntime)
        ? yield* Effect.acquireRelease(
            pluginRuntime.value.openSession({
              agentId: agent.id,
              metrics: runMetrics,
              ...(resolvedMaxCostUSD !== undefined ? { maxCostUSD: resolvedMaxCostUSD } : {}),
              ...(resolvedMaxDurationMs !== undefined
                ? {
                    hookTimeoutMs: Math.max(
                      1,
                      Math.min(
                        DEFAULT_PLUGIN_HOOK_TIMEOUT_MS,
                        resolvedMaxDurationMs - (Date.now() - runMetrics.startedAt.getTime()),
                      ),
                    ),
                  }
                : {}),
              currentRunCostUSD: () => runMetrics.decisionCostUSD ?? 0,
            }),
            (session) => session.close(),
          ).pipe(
            Effect.map(Option.some),
            Effect.catchAll((error) =>
              logger
                .warn("Plugin session failed to open; using deterministic behavior", {
                  errorCategory: telemetryErrorCategory(error),
                })
                .pipe(Effect.as(Option.none())),
            ),
          )
        : Option.none();

    const routingOutcome =
      options.isResume !== true && persona !== "summarizer" && Option.isSome(pluginSession)
        ? yield* pluginSession.value
            .runHook("route.skills", {
              requestText: userInput,
              skills: relevantSkills.map(({ name, description }) => ({ name, description })),
            })
            .pipe(
              Effect.catchAllCause((cause) =>
                Cause.isInterruptedOnly(cause)
                  ? Effect.failCause(cause)
                  : logger
                      .warn("Plugin skill routing failed; using deterministic behavior", {
                        errorCategory: telemetryErrorCategory(cause),
                      })
                      .pipe(Effect.as(undefined)),
              ),
            )
        : undefined;
    if (
      routingOutcome?.status === "abstained" &&
      routingOutcome.reason === "plugin handler failed"
    ) {
      yield* logger.warn("Plugin skill routing handler failed; using deterministic behavior");
    }
    const initialProviderAdvisory =
      routingOutcome !== undefined
        ? renderSkillRoutingAdvisory(
            routingOutcome,
            new Set(relevantSkills.map((skill) => skill.name)),
          )
        : undefined;

    // Register skill tools with discovered skill names as enum constraint
    yield* registerSkillSystemTools(relevantSkills.map((s) => s.name));

    // Get agent's tool names
    const agentToolNames = normalizeToolConfig(agent.config.tools, {
      agentId: agent.id,
    });

    // Registered per run rather than globally, because whether it exists at all depends on
    // the config: an agent with no peers never sees the tool.
    yield* registerPeerTools().pipe(Effect.catchAll(() => Effect.void));

    // Register MCP tools for this agent if needed (only connects to relevant servers)
    // This happens before validation so MCP tools are available
    const connectedMCPServers = yield* registerMCPToolsForAgent(agentToolNames).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          const logger = yield* LoggerServiceTag;
          yield* logger.warn("Failed to register MCP tools for agent", {
            errorCategory: telemetryErrorCategory(error),
          });
          // Continue even if MCP registration fails - tools might not be needed
          return [];
        }),
      ),
    );

    // Tools contributed by the agent's enabled plugins. Additive and fail-open, like MCP; enabling
    // a plugin is the opt-in, so these names are folded into the tool set below without needing a
    // separate mention in the agent's config.
    const pluginToolNames = yield* registerPluginToolsForAgent(agent.id);

    // Register the agent's declared custom tools (record handler only for now).
    // Unlike MCP registration above, failures here are NOT swallowed: a name
    // collision with an already-registered tool is a configuration error that
    // should fail agent startup rather than silently override the existing
    // tool.
    yield* registerCustomToolsForAgent(agent, agentToolNames);

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

    // Combine agent tools with built-in tools and enabled-plugin tools, then apply persona deny
    // list.
    let combinedToolNames = [
      ...new Set([...agentToolNames, ...builtInToolNames, ...pluginToolNames]),
    ];

    // Both scopes of denial, after everything that grants. Neither is undoable below: the
    // allowlist and carve-outs that follow can only narrow further.
    const denied = toolDenials(agent, toolProfile);
    combinedToolNames = combinedToolNames.filter((name) => !denied.has(name));

    // Ephemeral runs (jazz run --ephemeral) withhold the memory-writing tool
    // outright, so the model is never even offered a way to persist anything.
    if (options.disablePersistence === true) {
      combinedToolNames = combinedToolNames.filter((name) => name !== MANAGE_MEMORY_TOOL_NAME);
    }

    // Same reasoning for the tools that solicit an answer from a human. Failing the
    // call at execution time costs a round and invites the model to invent an
    // answer; not having the tool leaves it no choice but to decide openly.
    if (options.withholdInteractiveTools === true) {
      combinedToolNames = combinedToolNames.filter(
        (name) => name !== "ask_user_question" && name !== "ask_file_picker",
      );
    }

    // Applied after personas resolve (earlier would let a child's persona re-add
    // a category the parent denied) and before the registry filter.
    if (options.toolAllowlist) {
      const allowed = new Set(options.toolAllowlist);
      const withheld = combinedToolNames.filter((toolName) => !allowed.has(toolName));
      combinedToolNames = combinedToolNames.filter((toolName) => allowed.has(toolName));
      if (withheld.length > 0) {
        yield* logger.info("Tools withheld by inherited allowlist", {
          agentId: agent.id,
          withheldCount: withheld.length,
        });
      }
    }

    // Filter out any non-existent tools silently — tools may have been removed
    // or MCP servers may be unavailable. The agent can still operate with its
    // remaining tools.
    const allToolNames = yield* toolRegistry.listAllTools();
    combinedToolNames = combinedToolNames.filter((toolName) => allToolNames.includes(toolName));

    // Expand tool names to include approval execute tools and advertised aliases. These are
    // other names for a tool that already survived every filter above, so they are granted
    // with it: a run that may call `execute_command` has to be able to reach
    // `execute_execute_command` once the approval is answered, and the registry resolves
    // `glob` to `find`.
    const expandedToolNameSet = new Set(combinedToolNames);
    for (const toolName of combinedToolNames) {
      const tool = yield* toolRegistry.getTool(toolName);
      expandedToolNameSet.add(tool.name);
      if (tool.aliases) {
        for (const alias of tool.aliases) {
          expandedToolNameSet.add(alias);
        }
      }
      if (tool.approvalExecuteToolName) {
        expandedToolNameSet.add(tool.approvalExecuteToolName);
      }
    }

    // Denials run again over what expansion added, because expansion grants: a persona that
    // denies `glob` would otherwise get it back the moment `find` is granted. Denial has to
    // be the last word, or a deny entry is one alias away from meaningless.
    //
    // The allowlist deliberately is not re-applied. A peer's allowlist is built from
    // `listTools()`, which omits hidden tools, so it never names an execute half; narrowing
    // to it here would leave every gated tool proposable and none of them executable.
    // Advertisement and execution agree by sharing this one set instead.
    for (const toolName of expandedToolNameSet) {
      if (denied.has(toolName)) expandedToolNameSet.delete(toolName);
    }

    const expandedToolNames = Array.from(expandedToolNameSet);

    // Only `eager`-tier tools get full schemas in the request; `deferred`-tier ones (MCP
    // servers, background jobs, etc.) are rendered as a name/summary index in the prompt
    // instead, and their schemas are fetched on demand by `search_tools`. See
    // docs/superpowers/plans/tool-search-design.md.
    const { eager: eagerToolNames, deferred: deferredToolNames } =
      yield* toolRegistry.partitionByTier(expandedToolNames);
    const tools = Array.from(yield* toolRegistry.getToolDefinitionsFor(eagerToolNames));
    const deferredToolSummaries =
      deferredToolNames.length > 0 ? yield* toolRegistry.getToolSummaries(deferredToolNames) : [];

    // Build tool descriptions map
    const availableTools: Record<string, string> = {};
    for (const tool of tools) {
      availableTools[tool.function.name] = tool.function.description;
    }

    // AGENTS.md discovery. Uses the agent's tracked working directory when the
    // filesystem-context service is available (the agent can `cd` mid-session),
    // otherwise the process cwd. The summarizer compresses transcripts and has
    // no project to honor, so it never gets them.
    const projectInstructions = yield* resolveProjectInstructions(persona, agent.id, options);
    if (projectInstructions.length > 0) {
      yield* logger.debug("AGENTS.md instruction files loaded", {
        count: projectInstructions.length,
      });
    }

    // Attachment ingestion needs the agent's cwd to resolve relative paths the user typed, and
    // the model's modalities to know which of them are worth sending.
    //
    // Never for the summarizer: its "user input" is a rendered transcript, so any media path a
    // *tool* printed would be scanned as though the user had asked for it. Attaching files on
    // the strength of tool output is exactly what path ingestion must not do.
    const ingestsAttachments = persona !== "summarizer";
    const attachmentWorkingDirectory = ingestsAttachments
      ? yield* resolveAgentWorkingDirectory(agent.id, options)
      : undefined;
    const supportedAttachmentKinds = ingestsAttachments
      ? yield* resolveSupportedAttachmentKinds(agent)
      : [];
    // Whether this model can produce media itself. Drives one line of prompt guidance so a
    // text-only agent can point the user at one that can, instead of dead-ending.
    const canGenerateMedia = yield* resolveCanGenerateMedia(agent);
    const attachmentsAreLocal = isLocalServerProvider(agent.config.llmProvider);
    const activePreferences = yield* resolveActivePreferences(
      agent.config.memoryScopes ?? [DEFAULT_MEMORY_SCOPE],
      logger,
    );
    const memoryServiceForReceipts = yield* Effect.serviceOption(MemoryServiceTag);
    const memoryScopes = agent.config.memoryScopes ?? [DEFAULT_MEMORY_SCOPE];
    const memoryOpportunities = Option.isSome(memoryServiceForReceipts)
      ? createMemoryOpportunityRecorder({
          snapshotEntries: () => memoryServiceForReceipts.value.snapshotEntries(memoryScopes),
          fileSystem: yield* FileSystem.FileSystem,
          logger,
          viewMemoryOffered: expandedToolNames.includes(VIEW_MEMORY_TOOL_NAME),
        })
      : undefined;

    const currentMemorySource: MemorySource | undefined =
      options.trustUserInputAsMemorySource === true && options.isResume !== true
        ? { id: `user:${runMetrics.runId}`, text: userInput }
        : undefined;
    const memorySources =
      options.memorySources ?? collectMemorySources(history, currentMemorySource);

    // Build messages — reuses the PersonaService resolved earlier so custom
    // personas can be looked up by name when assembling the system prompt.
    const messages: ConversationMessages = yield* agentPromptBuilder.buildAgentMessages(
      persona,
      {
        agentName: agent.name,
        agentDescription: agent.description || "",
        userInput,
        ...(currentMemorySource !== undefined ? { memorySource: currentMemorySource } : {}),
        ...(options.isResume === true ? { isResume: true } : {}),
        conversationHistory: history,
        toolNames: expandedToolNames,
        availableTools,
        knownSkills: relevantSkills,
        ...(deferredToolSummaries.length > 0 && { deferredTools: deferredToolSummaries }),
        ...(activePreferences.length > 0 && { activePreferences }),
        ...(attachmentWorkingDirectory !== undefined && {
          workingDirectory: attachmentWorkingDirectory,
        }),
        supportedAttachmentKinds,
        attachmentsAreLocal,
        canGenerateMedia,
        ...(options.initialAttachments !== undefined && {
          initialAttachments: options.initialAttachments,
        }),
        ...(projectInstructions.length > 0 && { projectInstructions }),
        ...(options.pinInitialMessage === true ? { pinInitialMessage: true } : {}),
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

    // Support both static policy values and getter functions for real-time updates
    const getAutoApprovePolicy =
      options.autoApprovePolicy !== undefined
        ? typeof options.autoApprovePolicy === "function"
          ? options.autoApprovePolicy
          : () => options.autoApprovePolicy as AutoApprovePolicy
        : undefined;

    const toolContext: ToolExecutionContext = {
      agentId: agent.id,
      memorySources,
      telemetryTraceParent: {
        topRunId: runMetrics.telemetryParent?.topRunId ?? runMetrics.runId,
        parentRunId: runMetrics.runId,
        sessionId: runMetrics.telemetryParent?.sessionId ?? actualConversationId,
      },
      memoryScopes: agent.config.memoryScopes ?? [DEFAULT_MEMORY_SCOPE],
      conversationId: actualConversationId,
      model,
      ...(getAutoApprovePolicy !== undefined ? { getAutoApprovePolicy } : {}),
      ...(Option.isSome(pluginSession)
        ? {
            resolveCommandRisk: (command: string, conversationMessages?: readonly ChatMessage[]) =>
              resolveCommandRisk(command, agent, conversationMessages, runMetrics, (candidate) =>
                pluginSession.value.runPolicyHook("classify.command-risk", {
                  command: candidate,
                }),
              ),
          }
        : {}),
      // Always pass arrays by reference so that in-place mutations via
      // onAutoApproveCommand/onAutoApproveTool callbacks are visible to
      // subsequent isAutoApproved checks within the same agent run.
      autoApprovedCommands,
      autoApprovedTools,
      // What the executor rejects off-list calls against, and what a sub-agent inherits as
      // its allowlist: this run may execute the list it was offered, not whatever the
      // registry happens to hold.
      effectiveToolNames: expandedToolNameSet,
      ...(deferredToolNames.length > 0 ? { deferredToolNames } : {}),
      // `tools` is a real mutable array (see AgentRunContext) reused by reference across every
      // iteration of this run's loop, so pushing here makes a fetched schema callable on the
      // very next LLM request. Dedup by name: a repeat search_tools call for the same tool must
      // not send its schema twice.
      unlockDeferredTools: (definitions) => {
        const alreadyPresent = new Set(tools.map((t) => t.function.name));
        for (const definition of definitions) {
          if (!alreadyPresent.has(definition.function.name)) {
            tools.push(definition);
            alreadyPresent.add(definition.function.name);
          }
        }
      },
      // A sub-agent never parks: resuming one would mean replaying a child context that no
      // longer exists, so nested runs keep declining and the parent reasons about it.
      parkWhenUnattended: options.parkWhenUnattended === true && options.internal !== true,
      ...(options.onToolEvent !== undefined ? { onToolEvent: options.onToolEvent } : {}),
      ...(options.resolvedApprovals !== undefined
        ? { resolvedApprovals: options.resolvedApprovals }
        : {}),
      ...(options.resolvedUserInputs !== undefined
        ? { resolvedUserInputs: options.resolvedUserInputs }
        : {}),
      ...(options.resolvedFilePickers !== undefined
        ? { resolvedFilePickers: options.resolvedFilePickers }
        : {}),
      subagentDepth: options.subagentDepth ?? 0,
      maxSubagentDepth: Math.max(
        0,
        Math.floor(appConfig.maxSubagentDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH),
      ),
      maxSubagentIterations: Math.max(
        1,
        Math.floor(appConfig.maxSubagentIterations ?? DEFAULT_MAX_SUBAGENT_ITERATIONS),
      ),
      ...(options.timezone !== undefined ? { timezone: options.timezone } : {}),
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

    const compactPluginName = Option.isSome(pluginSession)
      ? pluginSession.value.describeHook("compact.tools")?.pluginName
      : undefined;

    return {
      agent,
      actualConversationId,
      context: toolContext,
      tools,
      expandedToolNames,
      messages,
      ...(memoryOpportunities !== undefined ? { memoryOpportunities } : {}),
      ...(initialProviderAdvisory !== undefined ? { initialProviderAdvisory } : {}),
      ...(Option.isSome(pluginSession)
        ? {
            workspaceContext: (input: WorkspaceContextInput) =>
              pluginSession.value.runWorkspace(input),
          }
        : {}),
      ...(Option.isSome(pluginSession)
        ? {
            reduceToolResults: buildAdvisedReducer({
              goal: userInput,
              provider,
              model,
              decide: (input) => pluginSession.value.runCompactTools(input),
            }),
          }
        : {}),
      ...(compactPluginName !== undefined ? { compactPluginName } : {}),
      runMetrics,
      provider,
      model,
      ...(typeof serverContextWindow === "number" ? { serverContextWindow } : {}),
      connectedMCPServers,
      maxRetries: Math.max(0, Math.floor(appConfig.maxRetries ?? DEFAULT_MAX_LLM_RETRIES)),
      maxIterations: resolvedMaxIterations,
      maxCostUSD: resolvedMaxCostUSD,
      maxTokens: resolvedMaxTokens,
      maxDurationMs: resolvedMaxDurationMs,
      knownSkills: relevantSkills,
    };
  });
}

/** Preserve the active trace when compaction or memory extraction starts a recursive run. */
export function createNestedRunExecutor(parent: TelemetryTraceParent): RecursiveRunner {
  return (options) => AgentRunner.runRecursive({ ...options, telemetryParent: parent });
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
    return Effect.scoped(
      Effect.gen(function* () {
        if (options.conversationId && options.internal !== true) {
          yield* Effect.tryPromise(() =>
            assertConversationWritable(options.agent.id, options.conversationId as string),
          );
        }
        // Get services
        const configService = yield* AgentConfigServiceTag;
        const appConfig = yield* configService.appConfig;

        // Initialize run context
        const runContext = yield* initializeAgentRun(options);

        // Internal runs without their own panel (compaction) must not take over
        // the parent's stream — a streamed completion finalizes the transcript,
        // idles the live zone, and looks like the turn ended. Sub-agents that
        // need a live panel pass ephemeralRegionId and keep streaming.
        const streamDetection = shouldEnableStreaming(
          appConfig,
          options.stream !== undefined ? { stream: options.stream } : {},
        );
        const shouldStream =
          streamDetection.shouldStream &&
          !(options.internal === true && options.ephemeralRegionId === undefined);

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

        const runRecursive = createNestedRunExecutor({
          topRunId: runContext.runMetrics.telemetryParent?.topRunId ?? runContext.runMetrics.runId,
          parentRunId: runContext.runMetrics.runId,
          sessionId:
            runContext.runMetrics.telemetryParent?.sessionId ?? runContext.actualConversationId,
        });

        const execute = shouldStream
          ? executeWithStreaming(
              options,
              runContext,
              displayConfig,
              streamingConfig,
              showMetrics,
              runRecursive,
            )
          : executeWithoutStreaming(options, runContext, displayConfig, showMetrics, runRecursive);

        // Priced once here rather than per transition: the lookup is a cached network fetch,
        // and a run that parks or fails should not pay for it twice.
        const pricing = yield* Effect.tryPromise({
          try: () => getModelsDevMetadata(runContext.model, runContext.provider),
          catch: () => undefined,
        }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));

        return yield* withRunRecording(
          {
            runId: options.runId ?? runContext.runMetrics.runId,
            agentId: options.agent.id,
            conversationId: runContext.actualConversationId,
            userInput: options.userInput,
            internal: options.internal === true,
            costSoFarUSD: () => runSpendUSD(runContext.runMetrics, pricing),
          },
          execute,
        );
      }),
    );
  }

  /**
   * Compacts a conversation now, exactly as a run does when its window fills: older
   * history folded into the running summary, recent messages kept verbatim. Returns
   * `undefined` when nothing is old enough to summarize.
   *
   * This is a public convenience method that delegates to the Summarizer module.
   *
   * Memory extraction stays off here. Its gate is `!internal && !disablePersistence`,
   * and a caller outside a run — `/compact` in chat — holds neither flag, so it cannot
   * answer for the run it is compacting. Automatic compaction still extracts when the
   * run permits it.
   */
  public static compactHistory(
    messages: ConversationMessages,
    agent: Agent,
    conversationId: string,
    contextWindowTokens: number,
    onPhase?: CompactionProgressObserver,
  ): Effect.Effect<
    CompactionOutcome | undefined,
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
      conversationId: string;
      maxIterations?: number;
    }) => AgentRunner.runRecursive(runOpts);

    return Effect.gen(function* () {
      const logger = yield* LoggerServiceTag;
      // Manual /compact has no live agent loop, so it never hit the clear rung where a
      // compact.tools plugin normally prunes. Open a short-lived session here and run the same
      // lossless pre-pass before the summary, so /compact is plugin-driven exactly like a run.
      const pluginRuntime = yield* Effect.serviceOption(PluginRuntimeServiceTag);
      if (Option.isNone(pluginRuntime)) {
        return yield* Summarizer.compact(
          messages,
          agent,
          conversationId,
          runRecursive,
          contextWindowTokens,
          false,
          undefined,
          onPhase,
        );
      }

      const provider = agent.config.llmProvider;
      const model = agent.config.llmModel;
      const goal =
        lastUserMessageText(messages) ??
        "Continue the current task; keep tool results still relevant to it.";
      const metrics = createAgentRunMetrics({ agent, conversationId, provider, model });

      return yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* Effect.acquireRelease(
            pluginRuntime.value.openSession({ agentId: agent.id, metrics }),
            (openedSession) => openedSession.close(),
          ).pipe(
            Effect.map(Option.some),
            Effect.catchAll((error) =>
              logger
                .warn("Plugin session failed to open for /compact; summarizing without pruning", {
                  errorCategory: telemetryErrorCategory(error),
                })
                .pipe(Effect.as(Option.none())),
            ),
          );

          const reduceToolResults = Option.isSome(session)
            ? buildAdvisedReducer({
                goal,
                provider,
                model,
                decide: (input) => session.value.runCompactTools(input),
              })
            : undefined;

          const pluginName = Option.isSome(session)
            ? session.value.describeHook("compact.tools")?.pluginName
            : undefined;
          const observedPhase: CompactionProgressObserver | undefined =
            onPhase === undefined
              ? undefined
              : pluginName === undefined
                ? onPhase
                : (event) =>
                    onPhase(
                      event.phase === "prune-start" || event.phase === "prune-done"
                        ? { ...event, plugin: pluginName }
                        : event,
                    );

          return yield* Summarizer.compact(
            messages,
            agent,
            conversationId,
            runRecursive,
            contextWindowTokens,
            false,
            reduceToolResults,
            observedPhase,
          );
        }),
      );
    });
  }
}

/** Most recent user message text, to hint the compaction prune at what is still relevant. */
function lastUserMessageText(messages: ConversationMessages): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (
      message &&
      message.role === "user" &&
      typeof message.content === "string" &&
      message.content.trim().length > 0
    ) {
      return message.content;
    }
  }
  return undefined;
}

// Re-export types for convenience
export type { AgentResponse, AgentRunContext, AgentRunnerOptions } from "./types";
