import { DEFAULT_CONTEXT_WINDOW } from "@/core/constants/models";

/**
 * Client for https://models.dev/api.json (~1MB JSON)
 *
 * Provides context window, tool_call, and reasoning metadata for models across
 * providers. Used by model-fetcher and ai-sdk-service to resolve model metadata.
 *
 * Efficiency:
 * - Lazy load: JSON fetched only on first use (when first model list is requested).
 * - In-memory cache: fetched once, cached for 1 hour (CACHE_TTL_MS), no repeated HTTP.
 * - Indexed map: parsed JSON → Map<modelId, metadata> for O(1) lookups.
 * - Per-provider cache: ai-sdk-service caches resolved ModelInfo[] so we don't even
 *   re-resolve after first provider load.
 *
 */

const MODELS_DEV_API_URL = "https://models.dev/api.json";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface ModelsDevMetadata {
  readonly contextWindow: number;
  readonly supportsTools: boolean;
  readonly isReasoningModel: boolean;
  /** Input price in USD per 1M tokens (from models.dev cost.input). */
  readonly inputPricePerMillion?: number;
  /** Output price in USD per 1M tokens (from models.dev cost.output). */
  readonly outputPricePerMillion?: number;
}

type ModelsDevProvider = {
  models?: Record<
    string,
    {
      limit?: { context?: number; output?: number };
      tool_call?: boolean;
      reasoning?: boolean;
      cost?: { input?: number; output?: number };
    }
  >;
};

type ModelsDevApi = Record<string, ModelsDevProvider>;

let cachedMap: Map<string, ModelsDevMetadata> | null = null;
let cacheExpiry = 0;

/**
 * Normalize model id for lookup: lowercase, and add a variant without :tag
 * so "qwen3:80b" can match entries that use the base name.
 */
function lookupKeys(modelId: string): string[] {
  const normalized = modelId.toLowerCase().trim();
  const keys = [normalized];
  const beforeColon = normalized.split(":")[0];
  if (typeof beforeColon === "string" && beforeColon !== normalized) {
    keys.push(beforeColon);
  }
  return keys;
}

/**
 * Build a flat map from all providers/models in the API.
 * Keys: "modelId" (last provider wins) and "providerId:modelId" for provider-scoped lookup (e.g. cost).
 */
function buildMap(api: ModelsDevApi): Map<string, ModelsDevMetadata> {
  const map = new Map<string, ModelsDevMetadata>();

  for (const [providerId, provider] of Object.entries(api)) {
    const models = provider.models;
    if (!models || typeof models !== "object") continue;

    const providerKey = providerId.toLowerCase().trim();

    for (const [id, spec] of Object.entries(models)) {
      if (!spec || typeof spec !== "object") continue;

      const context = spec.limit?.context;
      const contextWindow =
        typeof context === "number" && context > 0 ? context : DEFAULT_CONTEXT_WINDOW;

      const inputPrice =
        typeof spec.cost?.input === "number" && spec.cost.input >= 0 ? spec.cost.input : undefined;
      const outputPrice =
        typeof spec.cost?.output === "number" && spec.cost.output >= 0
          ? spec.cost.output
          : undefined;

      const meta: ModelsDevMetadata = {
        contextWindow,
        supportsTools: Boolean(spec.tool_call),
        isReasoningModel: Boolean(spec.reasoning),
        ...(inputPrice !== undefined && { inputPricePerMillion: inputPrice }),
        ...(outputPrice !== undefined && { outputPricePerMillion: outputPrice }),
      };

      const modelKey = id.toLowerCase().trim();
      map.set(modelKey, meta);
      map.set(`${providerKey}:${modelKey}`, meta);
    }
  }

  return map;
}

/**
 * Fetch the models.dev API and return the parsed map. Uses in-memory cache with TTL.
 */
export async function getModelsDevMap(): Promise<Map<string, ModelsDevMetadata> | null> {
  const now = Date.now();
  if (cachedMap !== null && now < cacheExpiry) {
    return cachedMap;
  }

  try {
    const response = await fetch(MODELS_DEV_API_URL, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;

    const api = (await response.json()) as ModelsDevApi;
    if (!api || typeof api !== "object") return null;

    cachedMap = buildMap(api);
    cacheExpiry = now + CACHE_TTL_MS;
    return cachedMap;
  } catch {
    return null;
  }
}

/**
 * Look up metadata from an already-fetched map. Tries provider:model first if providerId given, then exact match then base name (without :tag).
 * Use this when you have the map from getModelsDevMap() to avoid async per-model lookups.
 */
export function getMetadataFromMap(
  map: Map<string, ModelsDevMetadata> | null,
  modelId: string,
  providerId?: string,
): ModelsDevMetadata | undefined {
  if (!map) return undefined;
  const normalizedModel = modelId.toLowerCase().trim();
  if (providerId) {
    const providerKey = providerId.toLowerCase().trim();
    for (const key of lookupKeys(normalizedModel)) {
      const meta = map.get(`${providerKey}:${key}`);
      if (meta) return meta;
    }
  }
  for (const key of lookupKeys(modelId)) {
    const meta = map.get(key);
    if (meta) return meta;
  }
  return undefined;
}

/**
 * Look up metadata for a model by id. Optionally scope by provider for correct pricing.
 * Tries exact match then base name (without :tag). Returns undefined if not found or when models.dev is unavailable.
 */
export async function getModelsDevMetadata(
  modelId: string,
  providerId?: string,
): Promise<ModelsDevMetadata | undefined> {
  const map = await getModelsDevMap();
  return getMetadataFromMap(map, modelId, providerId);
}

/**
 * Clear the in-memory cache (e.g. for tests).
 */
export function clearModelsDevCache(): void {
  cachedMap = null;
  cacheExpiry = 0;
}
