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
