import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_CONTEXT_WINDOW } from "@/core/constants/models";
import { isOfflineMode } from "@/core/utils/offline";
import { getUserDataDirectory } from "@/core/utils/runtime-detection";

/**
 * Client for https://models.dev/api.json (~3MB JSON)
 *
 * Single source of truth for model catalogs and metadata across providers:
 * - Model lists per provider (id, display name, status, release date, modalities)
 * - Metadata (context window, tool_call, reasoning, vision, pdf, temperature, cost)
 *
 * Efficiency:
 * - Lazy load: JSON fetched only on first use (when first model list is requested).
 * - In-memory cache: fetched once, cached for 1 hour (CACHE_TTL_MS), no repeated HTTP.
 * - Indexed structures: flat Map<modelId, metadata> for O(1) metadata lookups, plus
 *   Map<providerId, entries[]> for provider model listings.
 * - Per-provider cache: ai-sdk-service caches resolved ModelInfo[] so we don't even
 *   re-resolve after first provider load.
 *
 * Airgapped / self-hosted operation:
 * - Every successful fetch is mirrored to <jazz home>/cache/models-dev.json; when the
 *   network is unreachable (or JAZZ_OFFLINE is set) that snapshot is used instead, however
 *   stale — stale metadata beats none, and local providers don't depend on it at all.
 * - JAZZ_MODELS_DEV_URL points the fetch at an internal mirror of api.json.
 * - The fetch is capped at FETCH_TIMEOUT_MS so a blackholed route can't hang model listing.
 */

const MODELS_DEV_API_URL = "https://models.dev/api.json";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const FETCH_TIMEOUT_MS = 10_000;
const DISK_CACHE_FILE = "models-dev.json";

export interface ModelsDevMetadata {
  readonly contextWindow: number;
  readonly supportsTools: boolean;
  readonly isReasoningModel: boolean;
  /** Whether the model accepts image input (vision). Derived from modalities.input containing "image". */
  readonly supportsVision: boolean;
  /** Whether the model accepts PDF input natively. Derived from modalities.input containing "pdf". */
  readonly supportsPdf: boolean;
  /** Whether the model accepts a custom temperature (from models.dev `temperature`). Defaults to true when absent. */
  readonly supportsTemperature: boolean;
  /** Input price in USD per 1M tokens (from models.dev cost.input). */
  readonly inputPricePerMillion?: number;
  /** Output price in USD per 1M tokens (from models.dev cost.output). */
  readonly outputPricePerMillion?: number;
}

/** One model as listed under a models.dev provider, with resolved metadata. */
export interface ModelsDevModelEntry {
  readonly id: string;
  readonly displayName: string;
  /** models.dev `status` — "deprecated" | "beta" | "alpha"; undefined means active. */
  readonly status?: string;
  /** ISO date (YYYY-MM-DD) from models.dev `release_date`. */
  readonly releaseDate?: string;
  readonly inputModalities: readonly string[];
  readonly outputModalities: readonly string[];
  readonly metadata: ModelsDevMetadata;
}

type ModelsDevModelSpec = {
  name?: string;
  status?: string;
  release_date?: string;
  limit?: { context?: number; output?: number };
  tool_call?: boolean;
  reasoning?: boolean;
  temperature?: boolean;
  modalities?: { input?: string[]; output?: string[] };
  cost?: { input?: number; output?: number };
};

type ModelsDevProvider = {
  models?: Record<string, ModelsDevModelSpec>;
};

type ModelsDevApi = Record<string, ModelsDevProvider>;

interface ModelsDevData {
  readonly metadataMap: Map<string, ModelsDevMetadata>;
  readonly providerModels: Map<string, readonly ModelsDevModelEntry[]>;
}

let cachedData: ModelsDevData | null = null;
let cacheExpiry = 0;
let inFlightLoad: Promise<ModelsDevData | null> | null = null;

/**
 * Normalize model id for lookup: lowercase, and add a variant without :tag
 * so "qwen3:80b" can match entries that use the base name.
 */
function lookupKeys(modelId: string): string[] {
  const normalized = modelId.toLowerCase().trim();
  const keys = [normalized];
  // Handle Ollama-style "model:tag" → try bare model name
  const beforeColon = normalized.split(":")[0];
  if (typeof beforeColon === "string" && beforeColon !== normalized) {
    keys.push(beforeColon);
  }
  // Handle OpenRouter-style "provider/model" → try bare model name and "provider:model" scoped key
  if (normalized.includes("/")) {
    const slashIndex = normalized.indexOf("/");
    const afterSlash = normalized.slice(slashIndex + 1);
    const beforeSlash = normalized.slice(0, slashIndex);
    if (afterSlash) {
      keys.push(afterSlash);
    }
    if (beforeSlash && afterSlash) {
      keys.push(`${beforeSlash}:${afterSlash}`);
    }
  }
  return keys;
}

function toMetadata(spec: ModelsDevModelSpec): ModelsDevMetadata {
  const context = spec.limit?.context;
  const contextWindow =
    typeof context === "number" && context > 0 ? context : DEFAULT_CONTEXT_WINDOW;

  const inputPrice =
    typeof spec.cost?.input === "number" && spec.cost.input >= 0 ? spec.cost.input : undefined;
  const outputPrice =
    typeof spec.cost?.output === "number" && spec.cost.output >= 0 ? spec.cost.output : undefined;

  const inputModalities = Array.isArray(spec.modalities?.input) ? spec.modalities.input : [];

  return {
    contextWindow,
    supportsTools: Boolean(spec.tool_call),
    isReasoningModel: Boolean(spec.reasoning),
    supportsVision: inputModalities.includes("image"),
    supportsPdf: inputModalities.includes("pdf"),
    supportsTemperature: spec.temperature !== false,
    ...(inputPrice !== undefined && { inputPricePerMillion: inputPrice }),
    ...(outputPrice !== undefined && { outputPricePerMillion: outputPrice }),
  };
}

/**
 * Build both indexes from the raw API payload:
 * - metadataMap keys: "modelId" (last provider wins) and "providerId:modelId" for provider-scoped lookup (e.g. cost).
 * - providerModels: providerId → full model entries for provider listings.
 */
function buildData(api: ModelsDevApi): ModelsDevData {
  const metadataMap = new Map<string, ModelsDevMetadata>();
  const providerModels = new Map<string, readonly ModelsDevModelEntry[]>();

  for (const [providerId, provider] of Object.entries(api)) {
    const models = provider.models;
    if (!models || typeof models !== "object") continue;

    const providerKey = providerId.toLowerCase().trim();
    const entries: ModelsDevModelEntry[] = [];

    for (const [id, spec] of Object.entries(models)) {
      if (!spec || typeof spec !== "object") continue;

      const meta = toMetadata(spec);
      const modelKey = id.toLowerCase().trim();
      metadataMap.set(modelKey, meta);
      metadataMap.set(`${providerKey}:${modelKey}`, meta);

      entries.push({
        id,
        displayName: typeof spec.name === "string" && spec.name.length > 0 ? spec.name : id,
        ...(typeof spec.status === "string" && { status: spec.status }),
        ...(typeof spec.release_date === "string" && { releaseDate: spec.release_date }),
        inputModalities: Array.isArray(spec.modalities?.input) ? spec.modalities.input : ["text"],
        outputModalities: Array.isArray(spec.modalities?.output)
          ? spec.modalities.output
          : ["text"],
        metadata: meta,
      });
    }

    providerModels.set(providerKey, entries);
  }

  return { metadataMap, providerModels };
}

function resolveApiUrl(): string {
  const override = process.env["JAZZ_MODELS_DEV_URL"];
  return override && override.length > 0 ? override : MODELS_DEV_API_URL;
}

function diskCachePath(): string {
  return join(getUserDataDirectory(), "cache", DISK_CACHE_FILE);
}

async function writeDiskCache(rawJson: string): Promise<void> {
  try {
    const path = diskCachePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, rawJson, "utf8");
  } catch (error) {
    // Best-effort mirror — an unwritable cache dir must never break model listing,
    // but a silent failure here would leave operators unable to diagnose why
    // offline mode has no snapshot to fall back on.
    console.warn(`Could not write models.dev disk cache: ${String(error)}`);
  }
}

async function loadFromDiskCache(now: number): Promise<ModelsDevData | null> {
  try {
    const raw = await readFile(diskCachePath(), "utf8");
    const api = JSON.parse(raw) as ModelsDevApi;
    if (!api || typeof api !== "object") return cachedData;

    cachedData = buildData(api);
    cacheExpiry = now + CACHE_TTL_MS;
    return cachedData;
  } catch {
    return cachedData;
  }
}

/**
 * Fetch and cache the models.dev payload. When the network is unreachable (or
 * JAZZ_OFFLINE is set) falls back to the on-disk snapshot from a previous run,
 * then to the previous in-memory cache (possibly stale, possibly null) —
 * callers decide how strict to be.
 *
 * Concurrent callers (e.g. several agents listing models at once before the
 * first load completes) share a single in-flight load instead of each firing
 * their own fetch and disk write.
 */
async function loadModelsDevData(): Promise<ModelsDevData | null> {
  const now = Date.now();
  if (cachedData !== null && now < cacheExpiry) {
    return cachedData;
  }

  if (inFlightLoad) {
    return inFlightLoad;
  }

  inFlightLoad = fetchAndCacheModelsDevData(now).finally(() => {
    inFlightLoad = null;
  });
  return inFlightLoad;
}

async function fetchAndCacheModelsDevData(now: number): Promise<ModelsDevData | null> {
  if (isOfflineMode()) {
    return loadFromDiskCache(now);
  }

  try {
    const response = await fetch(resolveApiUrl(), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return loadFromDiskCache(now);

    const rawJson = await response.text();
    const api = JSON.parse(rawJson) as ModelsDevApi;
    if (!api || typeof api !== "object") return loadFromDiskCache(now);

    cachedData = buildData(api);
    cacheExpiry = now + CACHE_TTL_MS;
    await writeDiskCache(rawJson);
    return cachedData;
  } catch {
    return loadFromDiskCache(now);
  }
}

/**
 * Fetch the models.dev API and return the metadata map. Uses in-memory cache with TTL.
 * Returns null when models.dev is unavailable and nothing is cached (lenient — used for
 * best-effort metadata enrichment of dynamically fetched model lists).
 */
export async function getModelsDevMap(): Promise<Map<string, ModelsDevMetadata> | null> {
  const data = await loadModelsDevData();
  return data?.metadataMap ?? null;
}

/**
 * List the models of a provider from the models.dev catalog.
 *
 * Strict: throws when models.dev is unreachable (and nothing is cached) or when the
 * provider is missing from the catalog. Model listings for catalog-backed providers
 * fully depend on models.dev — there is no fallback by design.
 */
export async function getModelsDevProviderModels(
  providerId: string,
): Promise<readonly ModelsDevModelEntry[]> {
  const data = await loadModelsDevData();
  if (!data) {
    throw new Error(
      isOfflineMode()
        ? "Model catalog unavailable: JAZZ_OFFLINE is set and no cached catalog exists. Local providers (ollama, llamacpp) list models without the catalog."
        : "Could not load the model catalog from models.dev — check your network connection and try again",
    );
  }
  const entries = data.providerModels.get(providerId.toLowerCase().trim());
  if (!entries) {
    throw new Error(`Provider "${providerId}" was not found in the models.dev catalog`);
  }
  return entries;
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
 * Synchronous cache-only lookup. Returns the metadata if the models-dev map
 * is already cached, or `undefined` when a network fetch would be needed.
 * Use this to avoid async work in hot rendering paths (e.g. cost display).
 */
export function getModelsDevMetadataSync(
  modelId: string,
  providerId?: string,
): ModelsDevMetadata | undefined {
  if (cachedData === null || Date.now() >= cacheExpiry) return undefined;
  return getMetadataFromMap(cachedData.metadataMap, modelId, providerId);
}

/**
 * Clear the in-memory cache (e.g. for tests).
 */
export function clearModelsDevCache(): void {
  cachedData = null;
  cacheExpiry = 0;
  inFlightLoad = null;
}
