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
}

type ModelsDevProvider = {
  models?: Record<
    string,
    {
      limit?: { context?: number; output?: number };
      tool_call?: boolean;
      reasoning?: boolean;
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
 * Later providers overwrite earlier for duplicate model ids (arbitrary but deterministic).
 */
function buildMap(api: ModelsDevApi): Map<string, ModelsDevMetadata> {
  const map = new Map<string, ModelsDevMetadata>();

  for (const provider of Object.values(api)) {
    const models = provider.models;
    if (!models || typeof models !== "object") continue;

    for (const [id, spec] of Object.entries(models)) {
      if (!spec || typeof spec !== "object") continue;

      const context = spec.limit?.context;
      const contextWindow =
        typeof context === "number" && context > 0 ? context : DEFAULT_CONTEXT_WINDOW;

      map.set(id.toLowerCase().trim(), {
        contextWindow,
        supportsTools: Boolean(spec.tool_call),
        isReasoningModel: Boolean(spec.reasoning),
      });
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
 * Look up metadata from an already-fetched map. Tries exact match then base name (without :tag).
 * Use this when you have the map from getModelsDevMap() to avoid async per-model lookups.
 */
export function getMetadataFromMap(
  map: Map<string, ModelsDevMetadata> | null,
  modelId: string,
): ModelsDevMetadata | undefined {
  if (!map) return undefined;
  for (const key of lookupKeys(modelId)) {
    const meta = map.get(key);
    if (meta) return meta;
  }
  return undefined;
}

/**
 * Look up metadata for a model by id. Tries exact match then base name (without :tag).
 * Returns undefined if not found or when models.dev is unavailable.
 */
export async function getModelsDevMetadata(
  modelId: string,
): Promise<ModelsDevMetadata | undefined> {
  const map = await getModelsDevMap();
  return getMetadataFromMap(map, modelId);
}

/**
 * Clear the in-memory cache (e.g. for tests).
 */
export function clearModelsDevCache(): void {
  cachedMap = null;
  cacheExpiry = 0;
}
