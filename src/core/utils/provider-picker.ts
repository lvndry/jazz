import type { ModelInfo } from "@/core/types/llm";
import { describeModelCapabilities } from "@/core/utils/model-capabilities";
import { formatProviderDisplayName } from "@/core/utils/provider-model";

export const PINNED_PROVIDERS_FOR_PICKER = [
  "openai",
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
 * prefix pins above its hundreds of plain catalog entries.
 */
const ROUTER_MODEL_PREFIX = "openrouter/";

function pinnedModelRank(providerId: string, modelId: string): number {
  if (
    canonicalizeProviderId(providerId) === "openrouter" &&
    modelId.startsWith(ROUTER_MODEL_PREFIX)
  ) {
    return 0;
  }
  const pinned = PINNED_MODELS_BY_PROVIDER[canonicalizeProviderId(providerId)];
  const rank = pinned?.indexOf(modelId) ?? -1;
  return rank === -1 ? Number.POSITIVE_INFINITY : rank;
}

/**
 * Order a provider's models for the picker: pinned entry points first, everything else in the
 * order the catalog supplied.
 */
export function sortModelsForPicker<T>(
  providerId: string,
  models: readonly T[],
  getId: (model: T) => string,
): T[] {
  return [...models].sort((left, right) => {
    const leftRank = pinnedModelRank(providerId, getId(left));
    const rightRank = pinnedModelRank(providerId, getId(right));
    if (leftRank === rightRank) {
      return 0;
    }
    return leftRank < rightRank ? -1 : 1;
  });
}

export interface ModelPickerChoice {
  readonly name: string;
  /** Capabilities and price, so nobody picks a model blind. */
  readonly description: string;
  readonly value: string;
}

/**
 * Ready-to-render choices for a provider's model picker.
 *
 * Single source for every model list (create-agent, edit-agent, future surfaces) so the
 * row shape — display name plus capability/price line — cannot drift between wizards.
 */
export function buildModelChoices(
  providerId: string,
  models: readonly ModelInfo[],
): ModelPickerChoice[] {
  return sortModelsForPicker(providerId, models, (model) => model.id).map((model) => ({
    name: model.displayName || model.id,
    description: describeModelCapabilities(model),
    value: model.id,
  }));
}
