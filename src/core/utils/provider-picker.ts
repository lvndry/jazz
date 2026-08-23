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
 * Models pinned to the top of a provider's model picker.
 *
 * OpenRouter lists hundreds of models; the two gateway meta-models are the ones that make
 * choosing OpenRouter worthwhile in the first place — `openrouter/free` is the no-cost entry
 * point and `openrouter/auto` picks a model for you — so burying them alphabetically among
 * 300+ siblings hides the reason a newcomer picked this provider. A pinned id that the
 * catalog does not offer simply never matches, so this stays correct as the catalog changes.
 */
const PINNED_MODELS_BY_PROVIDER: Readonly<Record<string, readonly string[]>> = {
  openrouter: ["openrouter/free", "openrouter/auto"],
};

function pinnedModelRank(providerId: string, modelId: string): number {
  const pinned = PINNED_MODELS_BY_PROVIDER[canonicalizeProviderId(providerId)];
  if (pinned === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  const rank = pinned.indexOf(modelId);
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
