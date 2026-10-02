import { registerMCPServerTools } from "@jazz/core/agent/tools/mcp";
import { getMCPServerCategories } from "@jazz/core/agent/tools/register-mcp-tools";
import {
  BUILTIN_TOOL_CATEGORIES,
  createCategoryMappings,
  FILE_MANAGEMENT_CATEGORY,
  HTTP_CATEGORY,
  mcpToolCategory,
  SHELL_COMMANDS_CATEGORY,
  WEB_SEARCH_CATEGORY,
} from "@jazz/core/agent/tools/tool-categories";
import {
  isLocalServerProvider,
  LOCAL_SERVER_PROVIDERS,
  type LocalServerProvider,
} from "@jazz/core/constants/local-providers";
import type { ProviderName } from "@jazz/core/constants/models";
import {
  buildOllamaContextChoices,
  defaultOllamaContextWindow,
  isOllamaCloudModel,
} from "@jazz/core/constants/ollama";
import { AgentConfigServiceTag, type AgentConfigService } from "@jazz/core/interfaces/agent-config";
import { AgentServiceTag, type AgentService } from "@jazz/core/interfaces/agent-service";
import type { JazzStateService } from "@jazz/core/interfaces/jazz-state";
import { JazzStateServiceTag } from "@jazz/core/interfaces/jazz-state";
import { LLMServiceTag, type LLMService } from "@jazz/core/interfaces/llm";
import { LoggerServiceTag, type LoggerService } from "@jazz/core/interfaces/logger";
import { MCPServerManagerTag, type MCPServerManager } from "@jazz/core/interfaces/mcp-server";
import { PersonaServiceTag, type PersonaService } from "@jazz/core/interfaces/persona-service";
import {
  TerminalServiceTag,
  type PromptStep,
  type PromptTagTone,
  type TerminalService,
} from "@jazz/core/interfaces/terminal";
import { ToolRegistryTag, type ToolRegistry } from "@jazz/core/interfaces/tool-registry";
import type { WebSearchProviderName } from "@jazz/core/types/config";
import {
  AgentAlreadyExistsError,
  AgentConfigurationError,
  type InteractiveTerminalRequiredError,
  LLMConfigurationError,
  StorageError,
  ValidationError,
} from "@jazz/core/types/errors";
import type { AgentConfig } from "@jazz/core/types/index";
import type { LLMProvider, LLMProviderListItem } from "@jazz/core/types/llm";
import type { MCPTool } from "@jazz/core/types/mcp";
import type { ReasoningSelection } from "@jazz/core/types/model-capabilities";
import { toError } from "@jazz/core/utils/errors";
import { isRecord } from "@jazz/core/utils/is-record";
import { isAuthenticationRequired } from "@jazz/core/utils/mcp";
import { formatProviderDisplayName } from "@jazz/core/utils/provider-model";
import { buildModelChoices, sortProvidersForPicker } from "@jazz/core/utils/provider-picker";
import { Effect } from "effect";
import { requireInteractiveTerminal } from "@/cli/helpers/interactive-terminal";
import { modelUsage, recordModelUsage } from "@/cli/helpers/model-recency";
import { promptForReasoningSelection } from "@/cli/helpers/reasoning";
import { ensureLocalProviderBaseUrl } from "@/cli/setup/local-provider-url";
import { ensureProviderApiKey } from "@/cli/setup/provider-api-key";
import { configureWebSearch } from "@/cli/setup/web-search";
import { configuredProviderNames } from "@/cli/ui/models/configured-providers";
import { ollamaOrigin, probeOllamaModels } from "../helpers/provider-detection";

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
  reasoning?: ReasoningSelection;
  numCtx?: number;
  tools: string[];
  webSearchProvider?: WebSearchProviderName;
}

/**
 * Interactive AI agent creation command
 */
export function createAgentCommand(
  options: {
    /** Skip the provider step and start from this provider, as home's Ollama fast path does. */
    readonly initialProvider?: ProviderName;
  } = {},
): Effect.Effect<
  void,
  | StorageError
  | AgentAlreadyExistsError
  | AgentConfigurationError
  | ValidationError
  | LLMConfigurationError
  | InteractiveTerminalRequiredError,
  | AgentService
  | LLMService
  | ToolRegistry
  | TerminalService
  | AgentConfigService
  | MCPServerManager
  | LoggerService
  | PersonaService
  | JazzStateService
> {
  return Effect.gen(function* () {
    yield* requireInteractiveTerminal(
      "jazz agent create",
      "Run `jazz agent create` in a terminal, or write the agent as JSON to $JAZZ_HOME/agents/<id>.json (normally ~/.jazz/agents/). See docs/configure/agents.md for the fields.",
    );
    const jazzState = yield* JazzStateServiceTag;
    const terminal = yield* TerminalServiceTag;

    const llmService = yield* LLMServiceTag;
    const configService = yield* AgentConfigServiceTag;
    const toolRegistry = yield* ToolRegistryTag;

    const personaService = yield* PersonaServiceTag;
    const allPersonas = yield* personaService.listPersonas();
    const personaChoices = allPersonas.map((persona) => ({
      name: persona.name,
      description: persona.description,
    }));
    const existingAgentNames = (yield* (yield* AgentServiceTag).listAgents()).map(
      (agent) => agent.name,
    );
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

    const actingToolCounts = yield* countActingTools(toolRegistry, toolsByCategory);
    const lastUsedModels = yield* modelUsage();

    const agentAnswers = yield* Effect.tryPromise({
      try: () =>
        promptForAgentInfo(
          personaChoices,
          toolsByCategory,
          llmService,
          configService,
          categoryIdToDisplayName,
          terminal,
          new Set(mcpServerData.displayNameToServerName.keys()),
          {
            ...(options.initialProvider === undefined
              ? {}
              : { initialProvider: options.initialProvider }),
            existingAgentNames,
            actingToolCounts,
            ...(lastUsedModels.size === 0 ? {} : { lastUsedModels }),
            jazzState,
          },
        ),
      catch: (error) =>
        new ValidationError({
          field: "agent",
          message: `Agent creation wizard failed: ${toError(error).message}`,
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
      yield* terminal.log("Discovering tools from MCP servers...");

      // Register tools from all selected MCP servers in parallel with timeout
      const registrationEffects = selectedServers.map((serverConfig) =>
        Effect.gen(function* () {
          yield* logger.debug("Registering MCP tools");

          // Discover tools from server with timeout (45 seconds per server to allow for authentication)
          const mcpTools = yield* mcpManager.discoverTools(serverConfig).pipe(
            Effect.timeout("45 seconds"),
            Effect.catchAll((error) =>
              Effect.gen(function* () {
                const errorMessage = toError(error).message;
                const isAuthRequired = isAuthenticationRequired(error);

                if (errorMessage.includes("timeout") || errorMessage.includes("Timeout")) {
                  if (isAuthRequired) {
                    yield* logger.warn("MCP connection timed out while awaiting authentication", {
                      errorType: "authentication_timeout",
                    });
                  } else {
                    yield* logger.warn("MCP connection timed out", { errorType: "timeout" });
                  }
                } else if (isAuthRequired) {
                  yield* logger.warn("MCP authentication required", {
                    errorType: "authentication_required",
                  });
                } else {
                  yield* logger.warn("MCP connection failed", { errorType: "connection_failed" });
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
          const category = mcpToolCategory(serverConfig.name);

          // Register tools
          const registerTool = toolRegistry.registerForCategory(category);
          const jazzTools = yield* registerMCPServerTools(serverConfig, mcpTools);

          for (const tool of jazzTools) {
            yield* registerTool(tool);
          }

          yield* logger.info("MCP tools registered", { toolCount: jazzTools.length });
        }).pipe(
          Effect.catchAll(() =>
            Effect.gen(function* () {
              // If registration fails, continue without this server's tools
              yield* logger.warn("MCP tool registration failed", {
                errorType: "registration_failed",
              });
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
      llm: {
        provider: agentAnswers.llmProvider,
        model: selectedModel,
        ...(agentAnswers.reasoning && { reasoning: agentAnswers.reasoning }),
        ...(typeof agentAnswers.numCtx === "number" && { numCtx: agentAnswers.numCtx }),
      },
      ...(uniqueToolNames.length > 0 && { tools: uniqueToolNames }),
      ...(agentAnswers.webSearchProvider && { webSearchProvider: agentAnswers.webSearchProvider }),
    };

    const agentService = yield* AgentServiceTag;
    const agent = yield* agentService.createAgent(
      agentAnswers.name,
      agentAnswers.description,
      config,
    );

    yield* terminal.success(
      `${agent.name} is ready · ${formatProviderDisplayName(config.llm.provider)} ${config.llm.model} · ${String(uniqueToolNames.length)} tools`,
    );
  });
}

/** The steps the wizard's stepper names, in order. Sub-steps sit under the nearest one. */
const STEPPER_LABELS = ["provider", "model", "reasoning", "persona", "name", "tools"] as const;

function stepperAt(label: (typeof STEPPER_LABELS)[number]): PromptStep {
  return { labels: STEPPER_LABELS, index: STEPPER_LABELS.indexOf(label) };
}

/** Agent names are identifiers: letters, numbers, `_` and `-`. */
const AGENT_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const AGENT_NAME_MAX_LENGTH = 100;
const AGENT_DESCRIPTION_MAX_LENGTH = 500;

/**
 * A name to prefill: the persona when it is not the default, else the model's last word with no
 * digits in it (`gpt-5.6-sol` → `sol`, `kimi-k3:cloud` → `kimi`), else the model name made safe
 * (`gemma4:12b` → `gemma4`). An Ollama `:tag` and any `org/` prefix never name the agent. A
 * clash gets a number.
 */
export function suggestAgentName(
  model: string,
  persona: string,
  existing: readonly string[],
): string {
  const family = (model.split("/").at(-1) ?? model).split(":")[0] ?? model;
  const words = family.split(/[^a-zA-Z0-9]+/).filter((word) => word.length > 0 && !/\d/.test(word));
  const base = (
    persona !== "default"
      ? persona
      : (words.at(-1) ?? family.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, ""))
  )
    .toLowerCase()
    .slice(0, AGENT_NAME_MAX_LENGTH);
  const taken = new Set(existing.map((name) => name.toLowerCase()));
  if (!taken.has(base)) {
    return base || "agent";
  }
  let suffix = 2;
  while (taken.has(`${base}-${String(suffix)}`)) suffix += 1;
  return `${base}-${String(suffix)}`;
}

/** Per tool category, how many of its tools can change something, so the picker can say so. */
function countActingTools(
  toolRegistry: ToolRegistry,
  toolsByCategory: Record<string, readonly string[]>,
): Effect.Effect<ReadonlyMap<string, number>> {
  return Effect.gen(function* () {
    const counts = new Map<string, number>();
    for (const [category, names] of Object.entries(toolsByCategory)) {
      let acting = 0;
      for (const name of names) {
        const tool = yield* toolRegistry.getTool(name).pipe(Effect.option);
        if (tool._tag === "Some" && tool.value.riskLevel !== "read-only") acting += 1;
      }
      counts.set(category, acting);
    }
    return counts;
  });
}

/** What the provider list says about each provider's readiness. */
function providerReadiness(
  provider: ProviderName,
  configured: ReadonlySet<string>,
  ollamaModels: number | undefined,
): { readonly tag: string; readonly tagTone: PromptTagTone } {
  if (provider === "ollama") {
    if (ollamaModels !== undefined) {
      return { tag: `running · ${String(ollamaModels)} models`, tagTone: "success" };
    }
    return configured.has(provider)
      ? { tag: "key saved", tagTone: "success" }
      : { tag: "not detected", tagTone: "muted" };
  }
  if (isLocalServerProvider(provider)) {
    return { tag: "local server", tagTone: "muted" };
  }
  if (provider === "chatgpt") {
    return configured.has(provider)
      ? { tag: "signed in", tagTone: "success" }
      : { tag: "sign in", tagTone: "muted" };
  }
  return configured.has(provider)
    ? { tag: "key saved", tagTone: "success" }
    : { tag: "needs a key", tagTone: "muted" };
}

/** The review lines that reopen a step. */
const REVIEW_EDIT_STEPS = ["name", "model", "persona", "tools"] as const;
type ReviewAnswer = (typeof REVIEW_EDIT_STEPS)[number] | "create";

/** Options for the wizard beyond the catalogs it picks from. */
export interface AgentInfoPromptOptions {
  /** Skip the provider step and start from this provider, as home's Ollama fast path does. */
  readonly initialProvider?: ProviderName;
  /** Names already taken, so the prefilled name is free and a clash is caught on the spot. */
  readonly existingAgentNames?: readonly string[];
  /** Last-picked millisecond per model, so the model step leads with recent picks. */
  readonly lastUsedModels?: ReadonlyMap<string, number>;
  /** Records model picks for recency ordering; omitted by callers without state. */
  readonly jazzState?: JazzStateService;
  /** Tools per category that can change something, from the tool registry. */
  readonly actingToolCounts?: ReadonlyMap<string, number>;
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
  | "review"
  | "done";

/**
 * State machine for agent creation wizard
 */
interface WizardState {
  step: WizardStep;
  // Collected answers (preserved when going back)
  llmProvider?: ProviderName;
  llmModel?: string;
  reasoning?: ReasoningSelection;
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
 * Resolve a local server's URL and load the models it serves.
 *
 * Each failure is shown and re-asks for whatever can fix it: a server that rejects the request
 * (401/403) re-asks for its API key, and an unreachable server or one serving no models re-asks
 * for the URL. A wrong saved value is corrected in place instead of aborting the wizard. When
 * the URL comes from an env var it cannot be re-prompted over, so the wizard falls back to
 * provider selection.
 */
async function connectLocalProvider(
  provider: LocalServerProvider,
  llmService: LLMService,
  configService: AgentConfigService,
  terminal: TerminalService,
): Promise<LLMProvider | "cancelled"> {
  const providerDisplayName = formatProviderDisplayName(provider);
  let forceUrl = false;
  let askUrl = true;
  while (true) {
    if (askUrl) {
      const urlResult = await ensureLocalProviderBaseUrl({
        configService,
        terminal,
        provider,
        force: forceUrl,
        step: stepperAt("provider"),
      });
      if (urlResult === "cancelled") {
        return "cancelled";
      }
      if (forceUrl && urlResult === "already-set") {
        await Effect.runPromise(
          terminal.warn(
            `${LOCAL_SERVER_PROVIDERS[provider].envVar} overrides the configured URL — fix it and try again.`,
          ),
        );
        return "cancelled";
      }
    }

    const outcome = await Effect.runPromise(llmService.getProvider(provider).pipe(Effect.either));
    if (outcome._tag === "Right" && outcome.right.supportedModels.length > 0) {
      return outcome.right;
    }

    if (outcome._tag === "Left" && outcome.left.reason === "unauthorized") {
      const keyResult = await ensureProviderApiKey({
        configService,
        terminal,
        provider,
        displayName: providerDisplayName,
        required: true,
        force: true,
        reason: outcome.left.message,
      });
      if (keyResult === "cancelled") {
        return "cancelled";
      }
      askUrl = false;
      continue;
    }

    await Effect.runPromise(
      terminal.error(
        outcome._tag === "Left"
          ? outcome.left.message
          : `The ${providerDisplayName} server is reachable but serves no models.`,
      ),
    );
    forceUrl = true;
    askUrl = true;
  }
}

/**
 * Prompt for basic agent information with ESC-based back navigation.
 *
 * Each step allows pressing ESC to go back to the previous step.
 * State is preserved when navigating backward.
 */
export async function promptForAgentInfo(
  personas: readonly { readonly name: string; readonly description?: string }[],
  toolsByCategory: Record<string, readonly string[]>,
  llmService: LLMService,
  configService: AgentConfigService,
  categoryIdToDisplayName: Map<string, string>,
  terminal: TerminalService,
  mcpCategoryDisplayNames: ReadonlySet<string>,
  options: AgentInfoPromptOptions = {},
): Promise<AIAgentCreationAnswers | null> {
  const state: WizardState = { step: "provider" };
  state.allProviders = await Effect.runPromise(llmService.listProviders());
  // A provider chosen before the wizard opened (home's Ollama fast path) is picked on step one.
  let pendingProvider = options.initialProvider;
  const existingAgentNames = options.existingAgentNames ?? [];
  const ollamaConfig: unknown = (
    (await Effect.runPromise(configService.appConfig)).llm as Record<string, unknown> | undefined
  )?.["ollama"];
  const ollamaModels = await probeOllamaModels(
    ollamaOrigin(
      isRecord(ollamaConfig) && typeof ollamaConfig["base_url"] === "string"
        ? ollamaConfig["base_url"]
        : undefined,
    ),
  );

  while (state.step !== "done") {
    switch (state.step) {
      // ═══════════════════════════════════════════════════════════════════════
      // STEP 1: Provider Selection
      // ═══════════════════════════════════════════════════════════════════════
      case "provider": {
        const preselected = pendingProvider;
        pendingProvider = undefined;
        const configured = new Set(
          configuredProviderNames(await Effect.runPromise(configService.appConfig)),
        );
        const result =
          preselected ??
          (await Effect.runPromise(
            terminal.search<ProviderName>("Which model provider?", {
              choices: sortProvidersForPicker(
                state.allProviders,
                (provider) => provider.name,
                (provider) => provider.displayName,
              ).map((provider) => ({
                name: provider.displayName ?? provider.name,
                value: provider.name,
                ...providerReadiness(provider.name, configured, ollamaModels),
              })),
              placeholder: "Type to filter providers",
              step: stepperAt("provider"),
            }),
          ));

        if (result === undefined) {
          return null;
        }

        state.llmProvider = result;

        const providerDisplayName =
          state.allProviders.find((p) => p.name === result)?.displayName ?? result;
        if (isLocalServerProvider(result)) {
          const localProvider = await connectLocalProvider(
            result,
            llmService,
            configService,
            terminal,
          );
          if (localProvider === "cancelled") {
            await Effect.runPromise(terminal.info("Nothing was saved. Pick another provider."));
            break;
          }
          state.providerInfo = localProvider;
          state.step = "model";
          break;
        }

        const keyResult = await ensureProviderApiKey({
          configService,
          terminal,
          provider: result,
          displayName: providerDisplayName,
          required: true,
        });
        if (keyResult === "cancelled") {
          await Effect.runPromise(terminal.info("Nothing was saved. Pick another provider."));
          break;
        }

        // Cache provider info for next step
        state.providerInfo = await Effect.runPromise(llmService.getProvider(result)).catch(
          (error: unknown) => {
            const message = toError(error).message;
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
        if (
          state.llmProvider === "llamacpp" ||
          ((state.llmProvider === "vllm" || state.llmProvider === "sglang") &&
            state.providerInfo!.supportedModels.length === 1)
        ) {
          const liveModel = state.providerInfo!.supportedModels[0];
          if (!liveModel) {
            throw new Error(
              `${formatProviderDisplayName(state.llmProvider)} did not report a served model.`,
            );
          }

          state.llmModel = liveModel.id;
          state.isReasoningModel = liveModel.isReasoningModel ?? false;
          state.supportsTools = liveModel.supportsTools;
          if (liveModel.contextWindow !== undefined) {
            state.detectedContextWindow = liveModel.contextWindow;
          }
          await Effect.runPromise(
            terminal.info(
              state.llmProvider === "llamacpp"
                ? `llama.cpp will use the model currently served by the server (${liveModel.id}).`
                : `${formatProviderDisplayName(state.llmProvider)} serves one model (${liveModel.id}); this agent will use that model.`,
            ),
          );
          state.step = state.isReasoningModel ? "reasoning" : "persona";
          break;
        }

        if (state.llmProvider === "vllm" || state.llmProvider === "sglang") {
          await Effect.runPromise(
            terminal.info(
              `Jazz uses this ${formatProviderDisplayName(state.llmProvider)} model while it is served. If the server stops listing it, Jazz uses the first live model instead.`,
            ),
          );
        }
        const result = await Effect.runPromise(
          terminal.search<string>(
            `Which ${formatProviderDisplayName(state.llmProvider!)} model? Context, then price in / out per million tokens.`,
            {
              choices: buildModelChoices(
                state.llmProvider!,
                state.providerInfo!.supportedModels,
                options.lastUsedModels,
              ),
              placeholder: "Type to filter models",
              step: stepperAt("model"),
            },
          ),
        );

        if (result === undefined) {
          state.step = "provider";
          break;
        }

        state.llmModel = result;
        if (options.jazzState !== undefined) {
          await Effect.runPromise(
            recordModelUsage(state.llmProvider!, result).pipe(
              Effect.provideService(JazzStateServiceTag, options.jazzState),
            ),
          );
        }

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
        if (selectedModel?.contextWindow !== undefined) {
          state.detectedContextWindow = selectedModel.contextWindow;
        }

        state.step = state.isReasoningModel ? "reasoning" : stepAfterReasoning(state);
        break;
      }

      // ═══════════════════════════════════════════════════════════════════════
      // STEP 3: Reasoning Effort (optional, only for reasoning models)
      // ═══════════════════════════════════════════════════════════════════════
      case "reasoning": {
        const control = await Effect.runPromise(
          llmService.resolveReasoningControl(state.llmProvider!, state.llmModel!),
        );
        const result = await promptForReasoningSelection(terminal, state.reasoning, {
          control,
          step: stepperAt("reasoning"),
        });

        if (result === undefined) {
          state.step =
            state.llmProvider === "llamacpp" ||
            ((state.llmProvider === "vllm" || state.llmProvider === "sglang") &&
              state.providerInfo?.supportedModels.length === 1)
              ? "provider"
              : "model";
          break;
        }

        state.reasoning = result;
        state.step = stepAfterReasoning(state);
        break;
      }

      // ═══════════════════════════════════════════════════════════════════════
      // STEP 3b: Ollama context window (only for Ollama agents)
      // ═══════════════════════════════════════════════════════════════════════
      case "ollamaContext": {
        const choices = buildOllamaContextChoices(state.detectedContextWindow);
        const result = await Effect.runPromise(
          terminal.select<number>("How much context should Ollama give it?", {
            choices,
            default: state.numCtx ?? defaultOllamaContextWindow(state.detectedContextWindow),
            step: stepperAt("model"),
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
          terminal.select<string>("What kind of assistant?", {
            choices: personas.map((persona) => ({
              name: persona.name,
              value: persona.name,
              ...(persona.description === undefined || persona.description.length === 0
                ? {}
                : { description: persona.description }),
            })),
            default: state.persona ?? "default",
            step: stepperAt("persona"),
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
              return "Give it a name";
            }
            if (inputValue.length > AGENT_NAME_MAX_LENGTH) {
              return `Keep it under ${String(AGENT_NAME_MAX_LENGTH)} characters`;
            }
            if (!AGENT_NAME_PATTERN.test(inputValue)) {
              return "Use letters, numbers, - and _ only, no spaces";
            }
            if (
              existingAgentNames.some((name) => name.toLowerCase() === inputValue.toLowerCase())
            ) {
              return `You already have an agent called ${inputValue}`;
            }
            return true;
          },
          cancellable: true,
          simple: true,
        };
        askOptions.defaultValue =
          state.name ?? suggestAgentName(state.llmModel!, state.persona!, existingAgentNames);

        const result = await Effect.runPromise(
          terminal.ask("What should we call it?", {
            ...askOptions,
            placeholder: "my-agent",
            step: stepperAt("name"),
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
            if (inputValue.length > AGENT_DESCRIPTION_MAX_LENGTH) {
              return `Keep it under ${String(AGENT_DESCRIPTION_MAX_LENGTH)} characters`;
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
          terminal.ask("What is it for? Optional, enter skips it.", {
            ...descOptions,
            placeholder: "Everyday help with email, calendar and planning",
            step: stepperAt("name"),
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
                `${state.llmModel} cannot use tools, so the ${currentPredefinedAgent.displayName} persona's tools are left out.`,
              ),
            );
          } else {
            await Effect.runPromise(
              terminal.info(`${state.llmModel} cannot use tools, so there are none to pick.`),
            );
          }
          state.tools = [];
          state.step = "review";
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
                `The ${currentPredefinedAgent.displayName} persona comes with: ${displayNames.join(", ")}`,
              );
              yield* terminal.log("");
            }),
          );

          state.tools = displayNames;
          state.step = "review";
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
          const toolSelection = await Effect.runPromise(
            terminal.checkbox<string>("What can it use?", {
              choices: selectableCategories.map(([category, toolsInCategory]) => {
                const acting = options.actingToolCounts?.get(category) ?? 0;
                return {
                  name: category,
                  value: category,
                  ...(toolsInCategory.length === 0
                    ? {}
                    : {
                        description: `${String(toolsInCategory.length)} ${toolsInCategory.length === 1 ? "tool" : "tools"}`,
                      }),
                  ...(acting > 0
                    ? {
                        tag: `${String(acting)} can change things`,
                        tagTone: "warning" as const,
                      }
                    : toolsInCategory.length > 0
                      ? { tag: "read only", tagTone: "muted" as const }
                      : {}),
                };
              }),
              default: [...selectedTools],
              step: stepperAt("tools"),
            }),
          );

          if (toolSelection === undefined) {
            shouldGoBack = true;
            break;
          }
          selectedTools = toolSelection;

          // Handle empty selection as potential back navigation
          if (selectedTools.length === 0) {
            // Ask if they want to go back or proceed with no tools
            const confirm = await Effect.runPromise(
              terminal.confirm("No tools picked. Go back and pick some?", true),
            );
            if (confirm === undefined) {
              continue;
            }
            if (confirm) {
              shouldGoBack = true;
              break;
            }
          }

          let resolvedTools = [...selectedTools];

          if (selectedTools.includes(WEB_SEARCH_CATEGORY.displayName)) {
            const webSearchProvider = await Effect.runPromise(
              configureWebSearch(
                terminal,
                configService,
                llmService,
                state.llmProvider!,
                stepperAt("tools"),
              ),
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

        state.step = "review";
        break;
      }

      // Every choice on one list: enter creates, and any line jumps back to its step.
      case "review": {
        const reasoning = state.reasoning === undefined ? "" : ` · reasoning ${state.reasoning}`;
        const toolCount = state.tools?.length ?? 0;
        const result = await Effect.runPromise(
          terminal.select<ReviewAnswer>("Ready to create", {
            choices: [
              { name: `Create ${state.name!} and start chatting`, value: "create" },
              { name: "name", value: "name", description: state.name! },
              {
                name: "model",
                value: "model",
                description: `${formatProviderDisplayName(state.llmProvider!)} · ${state.llmModel!}${reasoning}`,
              },
              { name: "persona", value: "persona", description: state.persona! },
              {
                name: "tools",
                value: "tools",
                description: toolCount === 0 ? "none" : (state.tools ?? []).join(", "),
              },
            ],
            default: "create",
          }),
        );
        if (result === undefined) {
          state.step = "tools";
          break;
        }
        // Only the listed lines can send the wizard back; anything else creates the agent.
        state.step = REVIEW_EDIT_STEPS.includes(result as (typeof REVIEW_EDIT_STEPS)[number])
          ? (result as WizardStep)
          : "done";
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
    ...(state.reasoning && { reasoning: state.reasoning }),
    ...(typeof state.numCtx === "number" && { numCtx: state.numCtx }),
    persona: state.persona!,
    name: state.name!,
    ...(state.description && { description: state.description }),
    tools: finalTools,
    ...(state.webSearchProvider && { webSearchProvider: state.webSearchProvider }),
  };
}
