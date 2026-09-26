import {
  isLocalServerProvider,
  LOCAL_SERVER_PROVIDERS,
  localServerAddress,
} from "@jazz/core/constants/local-providers";
import { DEFAULT_CONTEXT_WINDOW, type ProviderName } from "@jazz/core/constants/models";
import type { OllamaShowExtras } from "@jazz/core/interfaces/llm";
import type { ModelInfo } from "@jazz/core/types";
import type { LLMConfig } from "@jazz/core/types/config";
import { LLMConfigurationError } from "@jazz/core/types/errors";
import { isConnectionError, localServerUnreachableMessage } from "@jazz/core/utils/llm-error";
import {
  getMetadataFromMap,
  getModelsDevMap,
  getModelsDevProviderModels,
  type ModelsDevMetadata,
  type ModelsDevModelEntry,
} from "@jazz/core/utils/models-dev";
import { resolveOllamaAttachmentSupport } from "@jazz/core/utils/ollama-attachment-support";
import { toError } from "@jazz/core/utils/storage";
import { gateway } from "ai";
import { Effect } from "effect";
import { ChatGPTSignInRequiredError } from "./chatgpt/credentials";
import { fetchChatGPTModels } from "./chatgpt/transport";
import { PROVIDER_MODELS, resolveLocalProviderBaseUrl } from "./models";
import { hasReasoningParser } from "./reasoning";

/**
 * Model fetcher: models.dev as single source of metadata
 *
 * Architecture:
 * 1. Fetch models.dev once at start of fetchModels() for metadata (context, tool_call, reasoning).
 * 2. Each provider only supplies the list of models: id + displayName + optional fallback metadata.
 * 3. Shared resolve step: for each model, use models.dev when present, else provider fallback or defaults.
 * 4. No per-provider metadata heuristics; fallbacks only for models not in models.dev (e.g. Ollama /api/show).
 */

export interface ModelFetcherService {
  fetchModels(
    providerName: ProviderName,
    baseUrl: string,
    endpointPath: string,
    apiKey?: string,
  ): Effect.Effect<readonly ModelInfo[], LLMConfigurationError, never>;
}

/** Per-model entry from a provider before resolving metadata (models.dev or fallback). */
type RawModelEntry = {
  id: string;
  displayName: string;
  fallback?: Partial<ModelsDevMetadata>;
};

/**
 * Resolve to ModelInfo: models.dev first, then entry.fallback, then defaults.
 *
 * `catalogProvider` scopes the models.dev lookup to that provider's own listing first. When
 * only another host lists the model, its context window, tools and modalities still describe
 * the model, but its price belongs to that host, so the price is left unknown.
 */
function resolveToModelInfo(
  entry: RawModelEntry,
  devMap: Map<string, ModelsDevMetadata> | null,
  catalogProvider?: string,
): ModelInfo {
  const own =
    catalogProvider === undefined
      ? undefined
      : getMetadataFromMap(devMap, entry.id, catalogProvider, { anyProvider: false });
  const dev = own ?? getMetadataFromMap(devMap, entry.id);
  const priced = catalogProvider === undefined || own !== undefined;
  if (dev) {
    return {
      id: entry.id,
      displayName: entry.displayName,
      contextWindow: dev.contextWindow,
      supportsTools: dev.supportsTools,
      isReasoningModel: dev.isReasoningModel,
      ingestImage: dev.ingestImage,
      ingestPdf: dev.ingestPdf,
      ingestAudio: dev.ingestAudio,
      ingestVideo: dev.ingestVideo,
      generatesImage: dev.generatesImage,
      generatesAudio: dev.generatesAudio,
      generatesVideo: dev.generatesVideo,
      ...(priced &&
        dev.inputPricePerMillion !== undefined && {
          inputPricePerMillion: dev.inputPricePerMillion,
        }),
      ...(priced &&
        dev.outputPricePerMillion !== undefined && {
          outputPricePerMillion: dev.outputPricePerMillion,
        }),
      supportsTemperature: dev.supportsTemperature,
    };
  }
  const fb = entry.fallback;
  return {
    id: entry.id,
    displayName: entry.displayName,
    contextWindow: fb?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    supportsTools: fb?.supportsTools ?? false,
    isReasoningModel: fb?.isReasoningModel ?? false,
    ingestImage: fb?.ingestImage ?? false,
    ingestPdf: fb?.ingestPdf ?? false,
    ingestAudio: fb?.ingestAudio ?? false,
    ingestVideo: fb?.ingestVideo ?? false,
    supportsTemperature: fb?.supportsTemperature ?? true,
  };
}

/** Dated snapshot suffixes like "-20251001" or "-2024-05-13" (kept only when no undated base id exists). */
const DATED_SNAPSHOT_SUFFIX = /-(\d{8}|\d{4}-\d{2}-\d{2})$/;

/**
 * Keep models a person can actually hold a conversation with: text in, text out.
 *
 * That pair is the whole test, and it already excludes what this filter exists to exclude —
 * embeddings and TTS produce no text, transcription models like `whisper-large-v3` accept no
 * text, and a pure generator like `gpt-image-1` outputs only an image.
 *
 * It deliberately does *not* exclude a model that emits text **and** media. `gemini-3-pro-image`
 * and `gpt-image-1.5` converse normally and can also return an image, and generating media is a
 * capability of the model rather than a tool jazz provides — so the way to get an image is to
 * run an agent on a model that makes them. Hiding those models here made that impossible.
 */
function isTextChatModel(entry: ModelsDevModelEntry): boolean {
  return entry.inputModalities.includes("text") && entry.outputModalities.includes("text");
}

/**
 * List a provider's models from the models.dev catalog.
 *
 * models.dev is the single source of truth for these providers — no hardcoded lists,
 * no fallback. Filters to active text-chat models, drops dated snapshot duplicates
 * (e.g. "claude-haiku-4-5-20251001" when "claude-haiku-4-5" exists), and sorts by
 * release date, newest first.
 *
 * Throws when models.dev is unavailable.
 */
export async function fetchModelsDevModels(catalogId: string): Promise<ModelInfo[]> {
  const entries = await getModelsDevProviderModels(catalogId);

  const ids = new Set(entries.map((entry) => entry.id));
  const isSnapshotDuplicate = (id: string): boolean => {
    const base = id.replace(DATED_SNAPSHOT_SUFFIX, "");
    return base !== id && ids.has(base);
  };

  return entries
    .filter(
      (entry) =>
        entry.status !== "deprecated" && isTextChatModel(entry) && !isSnapshotDuplicate(entry.id),
    )
    .sort((left, right) => {
      const byDate = (right.releaseDate ?? "").localeCompare(left.releaseDate ?? "");
      return byDate !== 0 ? byDate : left.id.localeCompare(right.id);
    })
    .map((entry) => ({
      id: entry.id,
      displayName: entry.displayName,
      contextWindow: entry.metadata.contextWindow,
      supportsTools: entry.metadata.supportsTools,
      isReasoningModel: entry.metadata.isReasoningModel,
      ingestImage: entry.metadata.ingestImage,
      ingestPdf: entry.metadata.ingestPdf,
      ingestAudio: entry.metadata.ingestAudio,
      ingestVideo: entry.metadata.ingestVideo,
      generatesImage: entry.metadata.generatesImage,
      generatesAudio: entry.metadata.generatesAudio,
      generatesVideo: entry.metadata.generatesVideo,
      ...(entry.metadata.inputPricePerMillion !== undefined && {
        inputPricePerMillion: entry.metadata.inputPricePerMillion,
      }),
      ...(entry.metadata.outputPricePerMillion !== undefined && {
        outputPricePerMillion: entry.metadata.outputPricePerMillion,
      }),
      supportsTemperature: entry.metadata.supportsTemperature,
    }));
}

type OpenRouterModel = {
  id: string;
  name: string;
  context_length?: number;
  supported_parameters?: string[];
};

export type OllamaModel = {
  name: string;
  model?: string;
  details?: {
    family?: string;
    parameter_size?: string;
    metadata?: Record<string, unknown>;
  };
};

/**
 * Response from Ollama /api/show endpoint
 */
type OllamaShowResponse = {
  model_info?: Record<string, unknown>;
  details?: { family?: string };
  template?: string;
  capabilities?: string[];
};

type LlamaCppModelEntry = { id: string; max_model_len?: number };
type LlamaCppModelsResponse = { data?: LlamaCppModelEntry[] };
type OpenAICompatibleModelCard = { id: string; parent?: string; max_model_len?: number };

/** Accept only usable model cards from vLLM and SGLang's external `/v1/models` responses. */
function parseOpenAICompatibleModels(data: unknown): OpenAICompatibleModelCard[] {
  if (typeof data !== "object" || data === null || !("data" in data) || !Array.isArray(data.data)) {
    return [];
  }
  const cards = data.data as readonly unknown[];
  const models: OpenAICompatibleModelCard[] = [];
  for (const card of cards) {
    if (typeof card !== "object" || card === null || !("id" in card)) continue;
    if (typeof card.id !== "string" || card.id.trim().length === 0) continue;
    const length = "max_model_len" in card ? card.max_model_len : undefined;
    const parent = "parent" in card ? card.parent : undefined;
    models.push({
      id: card.id,
      ...(typeof parent === "string" && parent.length > 0 ? { parent } : {}),
      ...(typeof length === "number" && Number.isSafeInteger(length) && length > 0
        ? { max_model_len: length }
        : {}),
    });
  }
  return models;
}

/** LoRA cards can omit their length; use the listed base model's served limit. */
function resolveModelCardContextWindow(
  model: OpenAICompatibleModelCard,
  models: readonly OpenAICompatibleModelCard[],
): number | undefined {
  if (model.max_model_len !== undefined) return model.max_model_len;
  return models.find((candidate) => candidate.id === model.parent)?.max_model_len;
}
type LlamaCppPropsResponse = {
  default_generation_settings?: { n_ctx?: number };
  chat_template_caps?: Record<string, boolean>;
  chat_template?: string;
};

/**
 * Strip a trailing `/v1` (or `/v1/`) from a llama-server base URL so we can
 * reach the server-root `/props` endpoint. `/props` lives at the root, not
 * under `/v1`.
 */
function llamaCppServerRoot(baseUrl: string): string {
  // Strip trailing /v1 (or /v1/), then any trailing slash, so callers can safely append /props.
  return baseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "");
}

async function fetchLlamaCppProps(
  baseUrl: string,
  apiKey?: string,
): Promise<LlamaCppPropsResponse | undefined> {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    const response = await fetch(`${llamaCppServerRoot(baseUrl)}/props`, {
      method: "GET",
      headers,
    });
    if (!response.ok) return undefined;
    return (await response.json()) as LlamaCppPropsResponse;
  } catch {
    return undefined;
  }
}

/**
 * Ask a running llama-server what it is actually serving right now.
 *
 * A bare `llama-server` loads one model (chosen with `-m` at launch) and serves it
 * regardless of the `model` field a request carries, and that model can differ from
 * one run to the next. So rather than trusting the id stored on the agent, read the
 * live one from `/v1/models` (its first, and normally only, entry) and the real
 * context window from `/props` (`n_ctx`, the `-c` the server was started with),
 * falling back to `max_model_len` from `/v1/models` when `/props` is absent.
 * Returns an empty object when the server is unreachable or answers nothing usable —
 * callers fall back to the stored values.
 */
export async function fetchLlamaCppServerModel(
  baseUrl: string,
  apiKey?: string,
): Promise<{ modelId?: string; contextWindow?: number }> {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    const [modelsResponse, props] = await Promise.all([
      fetch(`${baseUrl}/models`, {
        method: "GET",
        headers,
      }),
      fetchLlamaCppProps(baseUrl, apiKey),
    ]);

    const firstModel = modelsResponse.ok
      ? ((await modelsResponse.json()) as LlamaCppModelsResponse).data?.[0]
      : undefined;
    const modelId = firstModel?.id;
    const contextWindow = props?.default_generation_settings?.n_ctx ?? firstModel?.max_model_len;

    return {
      ...(typeof modelId === "string" && modelId.length > 0 ? { modelId } : {}),
      ...(typeof contextWindow === "number" ? { contextWindow } : {}),
    };
  } catch {
    return {};
  }
}

/** Read a live OpenAI-compatible local model card, preferring the configured ID. */
async function fetchOpenAICompatibleServerModel(
  baseUrl: string,
  preferredModelId: string,
  apiKey?: string,
): Promise<{ modelId?: string; contextWindow?: number }> {
  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    const response = await fetch(`${baseUrl}/models`, { method: "GET", headers });
    if (!response.ok) return {};
    const models = parseOpenAICompatibleModels(await response.json());
    const model = models.find((candidate) => candidate.id === preferredModelId) ?? models[0];
    const contextWindow = model ? resolveModelCardContextWindow(model, models) : undefined;
    return {
      ...(typeof model?.id === "string" && model.id.length > 0 ? { modelId: model.id } : {}),
      ...(typeof contextWindow === "number" &&
      Number.isSafeInteger(contextWindow) &&
      contextWindow > 0
        ? { contextWindow }
        : {}),
    };
  } catch {
    return {};
  }
}

/** Resolve vLLM's currently served model and context window. */
export function fetchVllmServerModel(
  baseUrl: string,
  preferredModelId: string,
  apiKey?: string,
): Promise<{ modelId?: string; contextWindow?: number }> {
  return fetchOpenAICompatibleServerModel(baseUrl, preferredModelId, apiKey);
}

/** Resolve SGLang's currently served model and context window. */
export function fetchSglangServerModel(
  baseUrl: string,
  preferredModelId: string,
  apiKey?: string,
): Promise<{ modelId?: string; contextWindow?: number }> {
  return fetchOpenAICompatibleServerModel(baseUrl, preferredModelId, apiKey);
}

/**
 * Extract context length from Ollama model_info
 * The key format is `<family>.context_length` (e.g., "gemma3.context_length")
 */
function extractOllamaContextLength(
  modelInfo: Record<string, unknown> | undefined,
): number | undefined {
  if (!modelInfo) return undefined;

  for (const [key, value] of Object.entries(modelInfo)) {
    if (key.endsWith(".context_length") && typeof value === "number") {
      return value;
    }
  }
  return undefined;
}

/**
 * Fetch detailed model info from Ollama /api/show endpoint
 * Returns context window, template, and capabilities when available.
 * `baseUrl` is the canonical `/api` root (see resolveLocalProviderBaseUrl), so `/show` appends directly.
 */
export async function fetchOllamaModelDetails(
  baseUrl: string,
  modelName: string,
): Promise<OllamaShowExtras> {
  try {
    const response = await fetch(`${baseUrl}/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelName }),
    });
    if (!response.ok) return {};
    const data = (await response.json()) as OllamaShowResponse;
    const ctx = extractOllamaContextLength(data.model_info);
    return {
      ...(ctx !== undefined ? { contextWindow: ctx } : {}),
      ...(typeof data.template === "string" ? { template: data.template } : {}),
      ...(Array.isArray(data.capabilities) ? { capabilities: data.capabilities } : {}),
    };
  } catch {
    return {};
  }
}

const TOOL_PARAMS = new Set([
  "tools",
  "tool_choice",
  "function_call",
  "functions",
  "response_format:json_schema",
]);

/**
 * Tool support from Ollama's `/api/show` `capabilities` array
 * (e.g. ["completion","tools","thinking"]). Present for every modern tool-capable model,
 * including thinking/vision models like gemma4; tool capability is independent of the
 * thinking capability, so a model can have both. Never gate on the thinking/reasoning
 * capability.
 */
function ollamaToolSupportFromCapabilities(capabilities: readonly string[] | undefined): boolean {
  if (!capabilities) return false;
  return capabilities.includes("tools");
}

function ollamaToolSupportFromMetadata(model: OllamaModel): boolean {
  const metadata = model.details?.metadata;
  if (!metadata || typeof metadata !== "object") return false;
  const flag = metadata["supports_tools"] ?? metadata["tool_use"] ?? metadata["function_calling"];
  return typeof flag === "boolean" && flag;
}

/**
 * Authoritative tool-support decision for a local Ollama model.
 *
 * Ollama's `/api/show` `capabilities` array describes the actual model loaded on the host,
 * so it outranks models.dev. models.dev is matched by a normalized bare key
 * ("last-provider-wins"), which can miss an Ollama tag entirely or collide with a different
 * provider's same-named model and report a stale/wrong `tool_call` — either way it would
 * gate tools incorrectly. Precedence:
 *  1. `/api/show` capabilities, when present (authoritative for the real local model).
 *  2. models.dev `tool_call`, when the model resolved against models.dev.
 *  3. legacy `/api/tags` manifest metadata flags.
 *
 * This is shared by both the model-listing path and the agent run path, which resolve
 * supportsTools through the same fetched ModelInfo, so a tool-capable local model is never
 * silently stripped of its tools.
 */
export function resolveOllamaToolSupport(
  capabilities: readonly string[] | undefined,
  dev: ModelsDevMetadata | undefined,
  model: OllamaModel,
): boolean {
  if (capabilities !== undefined) {
    return ollamaToolSupportFromCapabilities(capabilities);
  }
  if (dev) {
    return dev.supportsTools;
  }
  return ollamaToolSupportFromMetadata(model);
}

// List extractors: provider API response → RawModelEntry[] (metadata resolved via models.dev or fallback)
/**
 * NVIDIA NIM's `/v1/models` also lists embedding, reranking, retrieval, guardrail, reward,
 * document-parsing and detector models, which take no conversation. Their IDs name the job,
 * and none of them are in the catalog as chat models, so the ID is the only signal.
 */
const NIM_NON_CHAT_MODEL_ID =
  /(?:embed|rerank|retriever|nemoguard|content-safety|safety-guard|reward|nemotron-parse|detector|nvclip)/;

const LIST_EXTRACTORS: Partial<Record<ProviderName, (data: unknown) => RawModelEntry[]>> = {
  openrouter: (data: unknown) => {
    const response = data as { data?: OpenRouterModel[] };
    return (response.data ?? []).map((model) => {
      const supportedParameters = model.supported_parameters ?? [];
      const isReasoningModel =
        supportedParameters.includes("reasoning") ||
        supportedParameters.includes("include_reasoning");
      const supportsTools = supportedParameters.some((param) => TOOL_PARAMS.has(param));
      return {
        id: model.id,
        displayName: model.name,
        fallback: {
          contextWindow: model.context_length ?? DEFAULT_CONTEXT_WINDOW,
          supportsTools,
          isReasoningModel,
          supportsTemperature: supportedParameters.includes("temperature"),
        },
      };
    });
  },
  ai_gateway: (data: unknown) => {
    const response = data as { id: string; name: string; tags?: string[] }[];
    return response.map((model) => ({
      id: model.id,
      displayName: model.name,
      fallback: {
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        supportsTools: model.tags?.includes("tool-use") ?? false,
        isReasoningModel: model.tags?.includes("reasoning") ?? false,
      },
    }));
  },
  groq: (data: unknown) => {
    const response = data as {
      data: { id: string; owned_by: string }[];
    };
    return response.data.map((model) => ({
      id: model.id,
      displayName: `${model.owned_by.toLowerCase()}/${model.id.toLowerCase()}`,
      // no fallback; models.dev or defaults
    }));
  },
  fireworks: (data: unknown) => {
    const response = data as {
      models?: {
        name: string;
        displayName?: string;
        contextLength?: number;
        supportsTools?: boolean;
        supportsImageInput?: boolean;
        state?: string;
        conversationConfig?: unknown;
        supportsServerless?: boolean;
      }[];
    };
    return (response.models ?? [])
      .filter(
        (model) => model.state === "READY" && model.conversationConfig && model.supportsServerless,
      )
      .map((model) => ({
        id: model.name,
        displayName: model.displayName ?? model.name,
        fallback: {
          contextWindow: model.contextLength ?? DEFAULT_CONTEXT_WINDOW,
          supportsTools: model.supportsTools ?? false,
          ingestImage: model.supportsImageInput ?? false,
        },
      }));
  },
  cerebras: (data: unknown) => {
    const response = data as {
      data: { id: string; owned_by?: string }[];
    };
    return response.data.map((model) => ({
      id: model.id,
      displayName: model.id,
      // no fallback; models.dev or defaults
    }));
  },
  nvidia: (data: unknown) => {
    const response = data as { data?: { id: string }[] };
    return (response.data ?? [])
      .filter((model) => !NIM_NON_CHAT_MODEL_ID.test(model.id))
      .map((model) => ({ id: model.id, displayName: model.id }));
  },
  orcarouter: (data: unknown) => {
    const response = data as {
      data: { id: string; name?: string; context_length?: number }[];
    };
    return (response.data ?? []).map((model) => ({
      id: model.id,
      displayName: model.name ?? model.id,
      fallback: {
        contextWindow: model.context_length ?? DEFAULT_CONTEXT_WINDOW,
      },
    }));
  },
  togetherai: (data: unknown) => {
    const models = data as {
      id: string;
      display_name?: string;
      type?: string;
      context_length?: number;
    }[];
    // Together.ai returns a flat array (not wrapped in { data }), filter to chat models only
    return models
      .filter((model) => model.type === "chat")
      .map((model) => ({
        id: model.id,
        displayName: model.display_name ?? model.id,
        fallback: {
          contextWindow: model.context_length ?? DEFAULT_CONTEXT_WINDOW,
        },
      }));
  },
};

/**
 * Ollama: list from /api/tags, resolve via models.dev or async fallback (/api/show + metadata).
 */
async function transformOllamaModels(
  data: unknown,
  baseUrl: string,
  modelsDevMap: Map<string, ModelsDevMetadata> | null,
): Promise<ModelInfo[]> {
  const response = data as { models?: OllamaModel[] };
  const models = response.models ?? [];
  const CONCURRENCY_LIMIT = 5;
  const results: ModelInfo[] = [];

  for (let i = 0; i < models.length; i += CONCURRENCY_LIMIT) {
    const batch = models.slice(i, i + CONCURRENCY_LIMIT);
    const batchResults = await Promise.all(
      batch.map(async (model): Promise<ModelInfo> => {
        const extras = await fetchOllamaModelDetails(baseUrl, model.name);
        const entry: RawModelEntry = { id: model.name, displayName: model.name };
        const dev = getMetadataFromMap(modelsDevMap, model.name);
        const supportsTools = resolveOllamaToolSupport(extras.capabilities, dev, model);
        const attachmentSupport = resolveOllamaAttachmentSupport(extras.capabilities, dev);
        let base: ModelInfo;
        if (dev) {
          base = resolveToModelInfo(entry, modelsDevMap);
        } else {
          entry.fallback = {
            contextWindow: extras.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
            supportsTools,
            isReasoningModel: hasReasoningParser({
              provider: "ollama",
              modelId: model.name,
              ...(extras.template ? { chatTemplate: extras.template } : {}),
              ...(extras.capabilities ? { capabilities: extras.capabilities } : {}),
            }),
          };
          base = resolveToModelInfo(entry, null);
        }
        return {
          ...base,
          supportsTools,
          ...attachmentSupport,
          // `/api/show` describes the model file actually on this host, so it outranks
          // the catalog's normalized bare-name match for the same reason tool support does.
          ...(extras.contextWindow !== undefined ? { contextWindow: extras.contextWindow } : {}),
          ...(extras.template ? { chatTemplate: extras.template } : {}),
          ...(extras.capabilities ? { capabilities: extras.capabilities } : {}),
        };
      }),
    );
    results.push(...batchResults);
  }

  return results;
}

// Lists /v1/models, enriches from /props. supportsTools needs both caps flags,
// which llama-server only populates under --jinja.
async function transformLlamaCppModels(
  data: unknown,
  baseUrl: string,
  modelsDevMap: Map<string, ModelsDevMetadata> | null,
  apiKey?: string,
): Promise<ModelInfo[]> {
  const response = data as LlamaCppModelsResponse;
  const models = response.data ?? [];
  if (models.length === 0) {
    throw new Error("No models loaded. Start `llama-server` with `-m <path>.gguf` first.");
  }

  const props = await fetchLlamaCppProps(baseUrl, apiKey);
  const ctx = props?.default_generation_settings?.n_ctx;
  const caps = props?.chat_template_caps ?? {};
  const supportsTools = caps["supports_tools"] === true && caps["supports_tool_calls"] === true;
  const chatTemplate = props?.chat_template;

  const isReasoning = hasReasoningParser({
    provider: "llamacpp",
    modelId: "",
    ...(chatTemplate ? { chatTemplate } : {}),
  });

  return models.map((model) => {
    const entry: RawModelEntry = { id: model.id, displayName: model.id };
    const dev = getMetadataFromMap(modelsDevMap, model.id);
    if (!dev) {
      entry.fallback = {
        contextWindow: ctx ?? DEFAULT_CONTEXT_WINDOW,
        supportsTools,
        isReasoningModel: isReasoning,
      };
    }
    const base = resolveToModelInfo(entry, dev ? modelsDevMap : null);
    return {
      ...base,
      // `/props` reports the window llama-server was started with (`-c`), which is what
      // it will honour — the catalog's advertised maximum is not.
      ...(ctx !== undefined ? { contextWindow: ctx } : {}),
      ...(chatTemplate ? { chatTemplate } : {}),
    };
  });
}

/** vLLM and SGLang report active max_model_len but do not expose tool parser flags. */
function transformOpenAICompatibleModels(
  data: unknown,
  modelsDevMap: Map<string, ModelsDevMetadata> | null,
  provider: "vllm" | "sglang",
): ModelInfo[] {
  const models = parseOpenAICompatibleModels(data);
  if (models.length === 0) {
    throw new Error(
      provider === "vllm"
        ? "No models loaded. Start `vllm serve <model>` first."
        : "No models loaded. Start `python -m sglang.launch_server --model-path <model>` first.",
    );
  }
  return models.map((model) => {
    const contextWindow = resolveModelCardContextWindow(model, models);
    const entry: RawModelEntry = {
      id: model.id,
      displayName: model.id,
      fallback: {
        contextWindow:
          typeof contextWindow === "number" &&
          Number.isSafeInteger(contextWindow) &&
          contextWindow > 0
            ? contextWindow
            : DEFAULT_CONTEXT_WINDOW,
        // These servers support tool calls, but `/models` does not expose whether this
        // deployment enabled automatic tool choice. Do not silently drop Jazz tools.
        supportsTools: true,
      },
    };
    const base = resolveToModelInfo(entry, modelsDevMap);
    return {
      ...base,
      ...(typeof contextWindow === "number" &&
      Number.isSafeInteger(contextWindow) &&
      contextWindow > 0
        ? { contextWindow }
        : {}),
    };
  });
}

class LocalServerUnauthorizedError extends Error {}

export function createModelFetcher(): ModelFetcherService {
  return {
    fetchModels: (providerName, baseUrl, endpointPath, apiKey) =>
      Effect.tryPromise({
        try: async () => {
          const url = `${baseUrl}${endpointPath}`;
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
          };

          if (apiKey) {
            headers["Authorization"] = `Bearer ${apiKey}`;
          }

          const modelsDevMap = await getModelsDevMap();

          if (providerName === "chatgpt") {
            // Plan-included models, so no models.dev lookup: its API pricing does not apply.
            const models = await fetchChatGPTModels();
            return models.map((model): ModelInfo => ({
              id: model.id,
              displayName: model.displayName,
              contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
              supportsTools: true,
              isReasoningModel: model.isReasoningModel,
              ingestImage: model.ingestImage,
              ingestPdf: false,
              ingestAudio: false,
              ingestVideo: false,
              supportsTemperature: !model.isReasoningModel,
            }));
          }

          if (providerName === "ai_gateway") {
            const availableModels = await gateway.getAvailableModels();
            const extractor = LIST_EXTRACTORS["ai_gateway"]!;
            const raw = extractor(availableModels.models);
            return raw.map((entry) => resolveToModelInfo(entry, modelsDevMap));
          }

          const response = await fetch(url, {
            method: "GET",
            headers,
          });

          if (!response.ok) {
            if (
              (response.status === 401 || response.status === 403) &&
              isLocalServerProvider(providerName)
            ) {
              throw new LocalServerUnauthorizedError(
                `The ${LOCAL_SERVER_PROVIDERS[providerName].name} server at ${localServerAddress(baseUrl)} rejected the request (${response.status}). It needs an API key.`,
              );
            }
            if (response.status === 404) {
              if (providerName === "ollama") {
                throw new Error(
                  "Failed to fetch models: No models found. Pull a model using `ollama pull` first.",
                );
              }
            }

            throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
          }

          const data: unknown = await response.json();

          if (providerName === "ollama") {
            return transformOllamaModels(data, baseUrl, modelsDevMap);
          }

          if (providerName === "llamacpp") {
            return transformLlamaCppModels(data, baseUrl, modelsDevMap, apiKey);
          }

          if (providerName === "vllm" || providerName === "sglang") {
            return transformOpenAICompatibleModels(data, modelsDevMap, providerName);
          }

          const extractor = LIST_EXTRACTORS[providerName];
          if (!extractor) {
            throw new Error(`No list extractor found for provider: ${providerName}`);
          }
          const raw = extractor(data);
          const source = PROVIDER_MODELS[providerName];
          const catalogProvider =
            source.type === "dynamic" ? (source.catalogId ?? providerName) : providerName;
          return raw.map((entry) => resolveToModelInfo(entry, modelsDevMap, catalogProvider));
        },
        catch: (error) => {
          if (error instanceof ChatGPTSignInRequiredError) {
            return new LLMConfigurationError({
              provider: providerName,
              message: error.message,
              reason: "unauthorized",
            });
          }
          if (error instanceof LocalServerUnauthorizedError) {
            return new LLMConfigurationError({
              provider: providerName,
              message: error.message,
              reason: "unauthorized",
            });
          }
          if (isConnectionError(error)) {
            const localMessage = localServerUnreachableMessage(providerName, baseUrl);
            if (localMessage) {
              return new LLMConfigurationError({ provider: providerName, message: localMessage });
            }
          }
          return new LLMConfigurationError({
            provider: providerName,
            message: `Model discovery failed: ${toError(error).message}`,
          });
        },
      }),
  };
}

/**
 * List a provider's available models, resolving from `PROVIDER_MODELS`
 * whether that means the models.dev catalog or a live fetch against the
 * provider's own endpoint. Callers own their own caching and credentials
 * (an already-resolved `apiKey`, and an optional `llmConfig` only used to
 * override a local server's base URL).
 */
export function listModelsForProvider(
  provider: ProviderName,
  options?: { readonly apiKey?: string | undefined; readonly llmConfig?: LLMConfig | undefined },
): Effect.Effect<readonly ModelInfo[], LLMConfigurationError, never> {
  const source = PROVIDER_MODELS[provider];

  if (source.type === "models-dev") {
    return Effect.tryPromise({
      try: () => fetchModelsDevModels(source.catalogId ?? provider),
      catch: (error) =>
        new LLMConfigurationError({
          provider,
          message: `Failed to list models from models.dev: ${toError(error).message}`,
        }),
    });
  }

  const baseUrl = isLocalServerProvider(provider)
    ? resolveLocalProviderBaseUrl(provider, options?.llmConfig)
    : source.defaultBaseUrl;
  if (baseUrl === undefined) {
    return Effect.succeed([]);
  }

  return createModelFetcher().fetchModels(provider, baseUrl, source.endpointPath, options?.apiKey);
}
