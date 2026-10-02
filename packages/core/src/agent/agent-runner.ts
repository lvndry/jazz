/**
 * `AgentRunner`: top-level entry point that resolves an agent's config, LLM, and
 * tool registry, then drives one conversation turn through the batch or streaming
 * executor depending on the model's capabilities.
 */

import { randomUUID } from "node:crypto";
import { FileSystem } from "@effect/platform";
import { Cause, Effect, Option, Scope } from "effect";
import {
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MAX_LLM_RETRIES,
  DEFAULT_MAX_SUBAGENT_DEPTH,
  DEFAULT_MAX_SUBAGENT_ITERATIONS,
} from "@/core/constants/agent";
import { isLocalServerProvider, isZeroCostLocalModel } from "@/core/constants/local-providers";
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
import { PresentationServiceTag, type PresentationService } from "@/core/interfaces/presentation";
import type { TelemetryTraceParent } from "@/core/interfaces/telemetry";
import type { TerminalService } from "@/core/interfaces/terminal";
import {
  ToolRegistryTag,
  type ToolRegistry,
  type ToolRequirements,
} from "@/core/interfaces/tool-registry";
import type { ActivePreference, SituationalPreference } from "@/core/memory/preference-line";
import { collectMemorySources } from "@/core/memory/source-trust";
import { resolveDisplayConfig } from "@/core/presentation/display-config";
import { closeUserSecretStore, openUserSecretStore } from "@/core/secrets/user-secrets";
import { SkillServiceTag, type SkillService } from "@/core/skills/skill-service";
import {
  guardRunStart,
  isUnattendedRun,
  releaseRunReservation,
  type RunAccountingInput,
  settleRunAccounting,
} from "@/core/spend/run-accounting";
import type { RunOrigin } from "@/core/spend/sources";
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
import { runBudgetOptions } from "@/core/types/remote-door";
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
import { closeUnansweredToolCalls } from "./context/unanswered-tool-calls";
import { assertConversationWritable } from "./detach/ownership";
import { executeWithStreaming, executeWithoutStreaming } from "./execution";
import { createEgressTaint, recordEgressTaint } from "./execution/egress-taint";
import { createMemoryOpportunityRecorder } from "./memory-opportunity-recorder";
import { MANAGE_MEMORY_TOOL_NAME, VIEW_MEMORY_TOOL_NAME } from "./memory-recall-log";
import {
  computeRunCost,
  createAgentRunMetrics,
  emitAgentRunStarted,
  recordSideSpend,
  runSpendReport,
  telemetryErrorCategory,
  type AgentRunMetrics,
} from "./metrics/agent-run-metrics";
import { discoverProjectInstructions, type ProjectInstructionFile } from "./project-instructions";
import type { RunRecordBoundary } from "./run/run-record";
import { withRunRecording } from "./run/run-recorder";
import { runToolDenials } from "./tools/agent-tool-resolution";
import { BrowserSessions } from "./tools/browser/session";
import { resolveCommandRisk } from "./tools/command-risk";
import { registerCustomToolsForAgent } from "./tools/custom";
import { registerMCPToolsForAgent } from "./tools/register-mcp-tools";
import { registerPluginToolsForAgent } from "./tools/register-plugin-tools";
import { registerBrowserAdoptionTools, registerPeerTools } from "./tools/register-tools";
import { registerSkillSystemTools } from "./tools/register-tools";
import { BUILTIN_TOOL_CATEGORIES, DEFAULT_AGENT_TOOL_CATEGORIES } from "./tools/tool-categories";
import { INTERACTIVE_TOOL_NAMES } from "./tools/user-interaction";
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
/** The memory entries injected into the system prompt: standing ones and situational ones. */
interface InjectedPreferences {
  readonly standing: readonly ActivePreference[];
  readonly situational: readonly SituationalPreference[];
}

const NO_INJECTED_PREFERENCES: InjectedPreferences = { standing: [], situational: [] };

/**
 * Reads every entry the model should see without asking: the ones that apply to every turn
 * (`always/`) and the ones that apply to a kind of task (`when/<topic>/`).
 *
 * Injected rather than looked up: recall that depends on the model choosing to
 * spend a tool call is recall it will sometimes skip, and a preference the user
 * already stated is not something they should have to restate. Situational entries
 * carry the situation they apply to so the model can combine several for one task.
 * Nothing is truncated; the entries are one thought each and the user wrote them
 * down on purpose.
 *
 * Memory is optional — an agent configured without it still runs — and a failure
 * to read degrades to injecting nothing rather than failing the run.
 */
export function resolveInjectedPreferences(
  logger: LoggerService,
): Effect.Effect<InjectedPreferences, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const memoryServiceOption = yield* Effect.serviceOption(MemoryServiceTag);
    if (Option.isNone(memoryServiceOption)) {
      yield* logger.debug("No memory service in context; skipping memory injection");
      return NO_INJECTED_PREFERENCES;
    }
    const memoryService = memoryServiceOption.value;
    return yield* Effect.gen(function* () {
      const standingEntries = yield* memoryService.standingEntries();
      const conditionalEntries = yield* memoryService.conditionalEntries();
      return {
        standing: standingEntries.map((entry) => ({
          scope: entry.scope,
          summary: entry.summary,
        })),
        situational: conditionalEntries.flatMap((entry) =>
          entry.topic === undefined
            ? []
            : [
                {
                  scope: entry.scope,
                  topic: entry.topic,
                  summary: entry.summary,
                  path: entry.path,
                },
              ],
        ),
      };
    }).pipe(
      Effect.catchAll((error) =>
        logger
          .warn("Failed to read memory; running without it", {
            errorCategory: telemetryErrorCategory(error),
          })
          .pipe(Effect.as(NO_INJECTED_PREFERENCES)),
      ),
    );
  });
}

function resolveCanGenerateMedia(
  agent: AgentRunnerOptions["agent"],
): Effect.Effect<boolean, never> {
  return Effect.gen(function* () {
    const metadata = yield* Effect.tryPromise({
      try: () => getModelsDevMetadata(agent.config.llm.model, agent.config.llm.provider),
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
      try: () => getModelsDevMetadata(agent.config.llm.model, agent.config.llm.provider),
      catch: (error) => error,
    }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));

    // Ollama reports the capabilities of the model file actually on this host, which the
    // catalog usually knows nothing about — most local tags are absent from models.dev
    // entirely. Without this, a local multimodal model reads as text-only and jazz refuses to
    // send it an image it can read perfectly well.
    if (agent.config.llm.provider === "ollama") {
      const llmService = yield* LLMServiceTag;
      const baseUrl = llmService.resolveLocalProviderBaseUrl("ollama", undefined);
      const extras = yield* llmService
        .fetchOllamaModelDetails(baseUrl, agent.config.llm.model)
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

/** Which of the operator's own inputs a run receives. See {@link runContextBoundary}. */
export interface RunContextBoundary {
  /** Scan `userInput` for local media paths and attach the files they name. */
  readonly ingestsUserInputPaths: boolean;
  /** Render the AGENTS.md files found for the working directory into the system prompt. */
  readonly injectsProjectInstructions: boolean;
  /** Render the operator's standing memory preferences into the system prompt. */
  readonly injectsPreferences: boolean;
}

/**
 * Which of the operator's own inputs this run receives.
 *
 * A run for a remote caller (a webhook or a peer) receives none of them. Preferences and
 * AGENTS.md describe the operator, which a `public` caller must never learn, and a path in the
 * caller's text names a file on this machine that the caller has no right to have uploaded.
 *
 * The summarizer gets no AGENTS.md and no path ingestion: its "user input" is a rendered
 * transcript, so a media path a tool printed would be scanned as though the user had asked for
 * it, and it has no project to honor.
 */
export function runContextBoundary(
  persona: string,
  options: Pick<AgentRunnerOptions, "ingestUserInputPaths" | "remoteCaller">,
): RunContextBoundary {
  const operatorIsCaller = options.remoteCaller === undefined;
  const isSummarizer = persona === "summarizer";
  return {
    ingestsUserInputPaths:
      operatorIsCaller && !isSummarizer && options.ingestUserInputPaths !== false,
    injectsProjectInstructions: operatorIsCaller && !isSummarizer,
    injectsPreferences: operatorIsCaller,
  };
}

function resolveProjectInstructions(
  boundary: RunContextBoundary,
  agentId: string,
  options: AgentRunnerOptions,
): Effect.Effect<readonly ProjectInstructionFile[], never> {
  return Effect.gen(function* () {
    if (!boundary.injectsProjectInstructions) return [];

    const workingDirectory = yield* resolveAgentWorkingDirectory(agentId, options);
    return yield* Effect.sync(() => discoverProjectInstructions(workingDirectory));
  });
}

/**
 * The answer a new run gives a call its history left unanswered, such as a parked approval
 * whose resume failed. That resume may have run the tool before failing, so the text does
 * not claim either way.
 */
const UNANSWERED_HISTORY_TOOL_RESULT =
  "No result was recorded for this tool call: the run that requested it ended first. It may or may not have run; check its effects before relying on them.";

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
    // A person watching a run can type `continue` — one nobody is watching cannot. Only
    // attended runs skip their default iteration cap; the presentation service reports
    // interactivity, so TTY chat and `jazz run` are both covered, and headless runs are not.
    const presentationService = yield* Effect.serviceOption(PresentationServiceTag);
    const attended =
      Option.isSome(presentationService) &&
      presentationService.value.canPromptForApproval?.() === true;

    const actualConversationId = conversationId || generateConversationId();
    const history: ChatMessage[] =
      options.isResume === true
        ? (options.conversationHistory ?? [])
        : closeUnansweredToolCalls(
            options.conversationHistory ?? [],
            UNANSWERED_HISTORY_TOOL_RESULT,
          );
    const persona = agent.config.persona;
    const provider: ProviderName = agent.config.llm.provider;
    // Local servers can change models between runs. The live model and window flow into
    // metrics, the footer, and context accounting; the saved ID is a fallback.
    const servedLlamaCppModel =
      provider === "llamacpp" ? yield* resolveLlamaCppServerModel(appConfig.llm) : undefined;
    const servedVllmModel =
      provider === "vllm"
        ? yield* resolveVllmServerModel(agent.config.llm.model, appConfig.llm)
        : undefined;
    const servedSglangModel =
      provider === "sglang"
        ? yield* resolveSglangServerModel(agent.config.llm.model, appConfig.llm)
        : undefined;
    const model =
      servedLlamaCppModel?.modelId ??
      servedVllmModel?.modelId ??
      servedSglangModel?.modelId ??
      agent.config.llm.model;
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

    // Attended terminal runs are unlimited by default (a person can `continue`); unattended
    // runs fall back to DEFAULT_MAX_ITERATIONS. An explicit --max-iterations or config value
    // always wins, even on a TTY — the cap is a default, not a wall.
    const resolvedMaxIterations = Math.max(
      1,
      Math.floor(
        options.maxIterations ??
          appConfig.maxIterations ??
          (attended ? Infinity : DEFAULT_MAX_ITERATIONS),
      ),
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
      reasoningEffort: agent.config.llm.reasoning ?? "disable",
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
    yield* registerBrowserAdoptionTools().pipe(Effect.catchAll(() => Effect.void));

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
      return DEFAULT_AGENT_TOOL_CATEGORIES.map((c) => c.id);
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
    const denied = runToolDenials(agent, toolProfile, options);
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
        (name) => !INTERACTIVE_TOOL_NAMES.includes(name),
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

    // Expand tool names to include approval execute tools, advertised aliases and companion
    // tools. Each belongs to a tool that already survived every filter above, so it is granted
    // with it: a run that may call `execute_command` has to be able to reach
    // `execute_execute_command` once the approval is answered, the registry resolves `glob` to
    // `find`, and children started with `spawn_subagent` are only collected by `wait_subagents`.
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
      for (const companion of tool.companionTools ?? []) {
        if (allToolNames.includes(companion)) {
          expandedToolNameSet.add(companion);
        }
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
    const boundary = runContextBoundary(persona, options);
    const projectInstructions = yield* resolveProjectInstructions(boundary, agent.id, options);
    if (projectInstructions.length > 0) {
      yield* logger.debug("AGENTS.md instruction files loaded", {
        count: projectInstructions.length,
      });
    }

    // Attachment ingestion needs the agent's cwd to resolve relative paths the user typed, and
    // the model's modalities to know which of them are worth sending.
    const ingestsAttachments = boundary.ingestsUserInputPaths;
    const attachmentWorkingDirectory = ingestsAttachments
      ? yield* resolveAgentWorkingDirectory(agent.id, options)
      : undefined;
    const supportedAttachmentKinds = ingestsAttachments
      ? yield* resolveSupportedAttachmentKinds(agent)
      : [];
    // Whether this model can produce media itself. Drives one line of prompt guidance so a
    // text-only agent can point the user at one that can, instead of dead-ending.
    const canGenerateMedia = yield* resolveCanGenerateMedia(agent);
    const attachmentsAreLocal = isLocalServerProvider(agent.config.llm.provider);
    const injectedPreferences = boundary.injectsPreferences
      ? yield* resolveInjectedPreferences(logger)
      : NO_INJECTED_PREFERENCES;
    const memoryServiceForReceipts = yield* Effect.serviceOption(MemoryServiceTag);
    const memoryOpportunities = Option.isSome(memoryServiceForReceipts)
      ? createMemoryOpportunityRecorder({
          snapshotEntries: () => memoryServiceForReceipts.value.snapshotEntries(),
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
        ...(injectedPreferences.standing.length > 0 && {
          activePreferences: injectedPreferences.standing,
        }),
        ...(injectedPreferences.situational.length > 0 && {
          situationalPreferences: injectedPreferences.situational,
        }),
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
      conversationId: actualConversationId,
      model,
      egressTaint: options.egressTaint ?? createEgressTaint(history),
      ...(getAutoApprovePolicy !== undefined ? { getAutoApprovePolicy } : {}),
      ...(Option.isSome(pluginSession)
        ? {
            resolveCommandRisk: (command: string, conversationMessages?: readonly ChatMessage[]) =>
              resolveCommandRisk(command, agent, conversationMessages, runMetrics, (candidate) =>
                pluginSession.value.runPolicyHook("classify.command-risk", {
                  command: candidate,
                }),
              ),
            classifyPage: pluginSession.value.runClassifyPage,
            routeSnapshot: pluginSession.value.runRouteSnapshot,
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
      ...(options.resolvedUserSecrets !== undefined
        ? { resolvedUserSecrets: options.resolvedUserSecrets }
        : {}),
      ...(options.userSecrets !== undefined ? { userSecrets: options.userSecrets } : {}),
      ...(options.browserSessions !== undefined
        ? { browserSessions: options.browserSessions }
        : {}),
      subagentDepth: options.subagentDepth ?? 0,
      maxSubagentDepth: Math.max(
        0,
        Math.floor(appConfig.maxSubagentDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH),
      ),
      maxSubagentIterations:
        options.maxSubagentIterations !== undefined
          ? Math.max(1, Math.floor(options.maxSubagentIterations))
          : appConfig.maxSubagentIterations !== undefined
            ? Math.max(1, Math.floor(appConfig.maxSubagentIterations))
            : attended
              ? Infinity
              : DEFAULT_MAX_SUBAGENT_ITERATIONS,
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

/** A run whose caller named no entry point is treated as an unattended `jazz run`. */
const DEFAULT_RUN_ORIGIN: RunOrigin = { source: "run" };
/** The limits a parked record must restore on resume, from the options the run started with. */
export function runRecordBoundary(options: AgentRunnerOptions): RunRecordBoundary {
  const budget = runBudgetOptions(options);
  return {
    ...(options.toolAllowlist !== undefined ? { toolAllowlist: options.toolAllowlist } : {}),
    ...(options.withholdInteractiveTools === true ? { withholdInteractiveTools: true } : {}),
    ...(options.disablePersistence === true ? { disablePersistence: true } : {}),
    ...(options.remoteCaller !== undefined ? { remoteCaller: options.remoteCaller } : {}),
    ...(Object.keys(budget).length > 0 ? { budget } : {}),
  };
}

/**
 * The runner compaction and memory extraction use for their own model runs: it keeps the
 * active trace, and folds each nested run's spend into the parent's metrics however the nested
 * run ends, so a summary that failed halfway is still paid for.
 */
export function createNestedRunExecutor(
  parent: TelemetryTraceParent,
  parentMetrics: AgentRunMetrics,
): RecursiveRunner {
  return (options) =>
    AgentRunner.runRecursive({
      ...options,
      telemetryParent: parent,
      onRunSpend: (spend) => recordSideSpend(parentMetrics, spend),
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
    return Effect.scoped(
      Effect.gen(function* () {
        if (options.conversationId && options.internal !== true) {
          yield* Effect.tryPromise({
            try: () =>
              assertConversationWritable(options.agent.id, options.conversationId as string),
            catch: (error) => (error instanceof Error ? error : new Error(String(error))),
          });
        }
        // Get services
        const configService = yield* AgentConfigServiceTag;
        const appConfig = yield* configService.appConfig;

        const presentation = yield* Effect.serviceOption(PresentationServiceTag);
        const origin = options.origin ?? DEFAULT_RUN_ORIGIN;
        const accounting: RunAccountingInput = {
          agentId: options.agent.id,
          agentName: options.agent.name,
          origin,
          internal: options.internal === true,
          unattended: isUnattendedRun(
            origin.source,
            Option.isSome(presentation) && presentation.value.canPromptForApproval?.() === true,
          ),
          appConfig,
          freeLocalModel: isZeroCostLocalModel(
            options.agent.config.llm.provider,
            options.agent.config.llm.model,
          ),
          reservationId: randomUUID(),
        };
        yield* Effect.addFinalizer(() => releaseRunReservation(accounting));
        yield* guardRunStart(accounting);

        // A top-level run holds the secrets its person types until it ends; a sub-agent shares
        // its parent's.
        const userSecrets =
          options.userSecrets ??
          (yield* Effect.acquireRelease(Effect.sync(openUserSecretStore), (store) =>
            Effect.sync(() => closeUserSecretStore(store)),
          ));

        // The run's browser launches on the first browser tool call; a top-level run closes it
        // when it ends, and a sub-agent shares its parent's.
        const browserSessions =
          options.browserSessions ??
          (yield* Effect.acquireRelease(
            Effect.sync(() => new BrowserSessions()),
            (sessions) => Effect.promise(() => sessions.close()),
          ));

        // Initialize run context
        const runContext = yield* initializeAgentRun({ ...options, userSecrets, browserSessions });

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

        const runRecursive = createNestedRunExecutor(
          {
            topRunId:
              runContext.runMetrics.telemetryParent?.topRunId ?? runContext.runMetrics.runId,
            parentRunId: runContext.runMetrics.runId,
            sessionId:
              runContext.runMetrics.telemetryParent?.sessionId ?? runContext.actualConversationId,
          },
          runContext.runMetrics,
        );

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
        const executeRecordingTaint = execute.pipe(
          Effect.map((response) =>
            response.messages === undefined
              ? response
              : {
                  ...response,
                  messages: recordEgressTaint(response.messages, runContext.context.egressTaint),
                },
          ),
        );

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
            costSoFarUSD: () => runSpendReport(runContext.runMetrics, pricing).costUSD,
            totalTokensSoFar: () =>
              runContext.runMetrics.totalPromptTokens + runContext.runMetrics.totalCompletionTokens,
            ...(options.autoApprovePolicy !== undefined &&
            typeof options.autoApprovePolicy !== "function"
              ? { approvalPolicy: options.autoApprovePolicy }
              : {}),
            ...(options.autoApprovedTools !== undefined
              ? { autoApprovedTools: options.autoApprovedTools }
              : {}),
            // Infinity (an attended unlimited run) is not JSON-serializable; a resumed segment
            // recomputes the same attended default, so the record only keeps a real cap.
            ...(Number.isFinite(runContext.maxIterations)
              ? { maxIterations: runContext.maxIterations }
              : {}),
            workingDirectory: yield* resolveAgentWorkingDirectory(options.agent.id, options),
            boundary: runRecordBoundary(options),
          },
          executeRecordingTaint,
        ).pipe(
          // Every way out, including failure and interruption: a run that died still spent.
          Effect.onExit(() =>
            Effect.sync(() => options.onRunSpend?.(runSpendReport(runContext.runMetrics, pricing))),
          ),
          Effect.onExit((exit) =>
            settleRunAccounting(
              accounting,
              {
                ...computeRunCost(runContext.runMetrics, pricing),
                totalTokens:
                  runContext.runMetrics.totalPromptTokens +
                  runContext.runMetrics.totalCompletionTokens,
              },
              exit,
              options.runId ?? runContext.runMetrics.runId,
            ),
          ),
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

      const provider = agent.config.llm.provider;
      const model = agent.config.llm.model;
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
