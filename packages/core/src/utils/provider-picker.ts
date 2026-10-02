/**
 * Sort order for provider and model pickers: pinned providers/models (e.g.
 * OpenRouter's router meta-models) surface above the rest of the catalog, and
 * a provider's models lead with the ones the user picked most recently.
 */
import type { ModelInfo } from "@/core/types/llm";
import { trimNumber } from "@/core/utils/model-capabilities";
import { formatProviderDisplayName } from "@/core/utils/provider-model";
import { formatCompactCount } from "@/core/utils/string";

export const PINNED_PROVIDERS_FOR_PICKER = [
  "openai",
  "chatgpt",
  "anthropic",
  "gemini",
  "openrouter",
  "ollama",
] as const;

const PROVIDER_ID_ALIASES: Readonly<Record<string, string>> = {
  google: "gemini",
};

const CONFIGURED_SUFFIX = /\s*\(configured\)\s*$/i;

export function canonicalizeProviderId(providerId: string): string {
  const normalized = providerId.trim().toLowerCase();
  return PROVIDER_ID_ALIASES[normalized] ?? normalized;
}

function pinnedRank(providerId: string): number {
  const canonicalId = canonicalizeProviderId(providerId);
  const rank = (PINNED_PROVIDERS_FOR_PICKER as readonly string[]).indexOf(canonicalId);
  return rank === -1 ? Number.POSITIVE_INFINITY : rank;
}

function pickerSortName(providerId: string, displayName?: string): string {
  const rawName = displayName?.trim() ? displayName : formatProviderDisplayName(providerId);
  return rawName.replace(CONFIGURED_SUFFIX, "").trim();
}

export function sortProvidersForPicker<T>(
  providers: readonly T[],
  getId: (provider: T) => string = (provider) => String(provider),
  getDisplayName?: (provider: T) => string | undefined,
): T[] {
  return [...providers].sort((left, right) => {
    const leftId = getId(left);
    const rightId = getId(right);
    const leftRank = pinnedRank(leftId);
    const rightRank = pinnedRank(rightId);
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }

    const leftName = pickerSortName(leftId, getDisplayName?.(left));
    const rightName = pickerSortName(rightId, getDisplayName?.(right));
    const byDisplayName = leftName.localeCompare(rightName, "en", { sensitivity: "base" });
    if (byDisplayName !== 0) {
      return byDisplayName;
    }

    return canonicalizeProviderId(leftId).localeCompare(canonicalizeProviderId(rightId), "en");
  });
}

/**
 * Per-provider model ids pinned above their siblings. Empty today — OpenRouter's
 * routers are covered wholesale by the prefix rule below — but the place to add
 * a provider's named entry points when one earns them.
 */
const PINNED_MODELS_BY_PROVIDER: Readonly<Record<string, readonly string[]>> = {};

/**
 * OpenRouter's own ids (`openrouter/free`, `openrouter/auto`, `openrouter/fusion`, …)
 * are router meta-models — the reason to pick this provider at all — so the whole
 * prefix pins above its hundreds of plain catalog entries. `free` leads the group
 * since it's the entry point with no cost attached.
 */
const ROUTER_MODEL_PREFIX = "openrouter/";
const ROUTER_MODEL_ORDER = ["openrouter/free", "openrouter/auto"] as const;

function pinnedModelRank(providerId: string, modelId: string): number {
  if (
    canonicalizeProviderId(providerId) === "openrouter" &&
    modelId.startsWith(ROUTER_MODEL_PREFIX)
  ) {
    const routerRank = ROUTER_MODEL_ORDER.indexOf(modelId as (typeof ROUTER_MODEL_ORDER)[number]);
    return routerRank === -1 ? 0 : routerRank - ROUTER_MODEL_ORDER.length;
  }
  const pinned = PINNED_MODELS_BY_PROVIDER[canonicalizeProviderId(providerId)];
  const rank = pinned?.indexOf(modelId) ?? -1;
  return rank === -1 ? Number.POSITIVE_INFINITY : rank;
}

/**
 * Order a provider's models for the picker: pinned entry points first, then models by how
 * recently the user picked them (most recent first), then the order the catalog supplied.
 * `lastUsedMs` maps a model to an epoch millisecond; unknown models have no recency.
 */
export function sortModelsForPicker<T>(
  providerId: string,
  models: readonly T[],
  getId: (model: T) => string,
  lastUsedMs?: ReadonlyMap<string, number>,
): T[] {
  return [...models].sort((left, right) => {
    const leftRank = pinnedModelRank(providerId, getId(left));
    const rightRank = pinnedModelRank(providerId, getId(right));
    if (leftRank !== rightRank) {
      return leftRank < rightRank ? -1 : 1;
    }
    const leftAt = modelLastUsedAt(providerId, getId(left), lastUsedMs) ?? -1;
    const rightAt = modelLastUsedAt(providerId, getId(right), lastUsedMs) ?? -1;
    if (leftAt !== rightAt) {
      return rightAt - leftAt;
    }
    return 0;
  });
}

/** When a model was last picked, or undefined; also matches the id alone, so a rename keeps it. */
function modelLastUsedAt(
  providerId: string,
  modelId: string,
  lastUsedMs?: ReadonlyMap<string, number>,
): number | undefined {
  if (lastUsedMs === undefined) {
    return undefined;
  }
  return lastUsedMs.get(`${providerId}/${modelId}`) ?? lastUsedMs.get(modelId);
}

export interface ModelPickerChoice {
  readonly name: string;
  /** Context window, a tab, then price in / out: a picker that aligns tab columns reads it as a table. */
  readonly description: string;
  readonly value: string;
  /** What the model can do beyond text, as words: "reasoning vision". Empty when nothing extra. */
  readonly tag?: string;
}

function priceText(inputPrice: number | undefined, outputPrice: number | undefined): string {
  if (inputPrice === undefined && outputPrice === undefined) {
    return "price unknown";
  }
  if (inputPrice === 0 && outputPrice === 0) {
    return "free";
  }
  const format = (price: number | undefined): string =>
    price === undefined ? "?" : `$${trimNumber(price)}`;
  return `${format(inputPrice)} / ${format(outputPrice)}`;
}

/** The capability words a model earns beyond reading and writing text. */
export function modelCapabilityWords(model: ModelInfo): string[] {
  const words: string[] = [];
  if (model.isReasoningModel === true) words.push("reasoning");
  if (model.supportsTools === false) words.push("no tools");
  if (model.ingestImage === true) words.push("vision");
  if (model.ingestAudio === true) words.push("audio");
  if (model.ingestVideo === true) words.push("video");
  if (model.generatesImage === true) words.push("makes images");
  return words;
}

/**
 * Ready-to-render choices for a provider's model picker.
 *
 * Single source for every model list (create-agent, edit-agent, future surfaces) so the
 * row shape — display name plus capability/price line — cannot drift between wizards.
 * `lastUsedMs` orders picked models by most recent use; see `sortModelsForPicker`.
 */
export function buildModelChoices(
  providerId: string,
  models: readonly ModelInfo[],
  lastUsedMs?: ReadonlyMap<string, number>,
): ModelPickerChoice[] {
  return sortModelsForPicker(providerId, models, (model) => model.id, lastUsedMs).map((model) => {
    const context =
      model.contextWindow === undefined ? "" : formatCompactCount(model.contextWindow);
    const words = modelCapabilityWords(model);
    return {
      name: model.displayName || model.id,
      description: `${context}\t${priceText(model.inputPricePerMillion, model.outputPricePerMillion)}`,
      value: model.id,
      ...(words.length === 0 ? {} : { tag: words.join(" ") }),
    };
  });
}
