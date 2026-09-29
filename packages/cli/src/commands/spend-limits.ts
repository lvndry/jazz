/**
 * The spend caps the configuration wizard edits: a daily and a monthly dollar cap for goal work
 * (goal cycles and loops) and for every unattended run on this machine, both under `daemon` in
 * config.json, plus a default per-session cap for chat under `chat`. Each is unlimited until
 * set, and clearing one makes it unlimited again.
 *
 * `parseSpendLimitInput` reads what a person typed; `applySpendLimit` writes it (or removes the
 * key, for unlimited) through the config service, so the wizard and its tests share one rule.
 */

import type { AgentConfigService } from "@jazz/core/interfaces/agent-config";
import type { AppConfig } from "@jazz/core/types/config";
import { Effect } from "effect";

export interface SpendLimitSetting {
  readonly key: string;
  readonly label: string;
  readonly read: (config: AppConfig) => number | undefined;
}

/** Goal caps come first, then chat's own default. */
export const SPEND_LIMIT_SETTINGS: readonly SpendLimitSetting[] = [
  {
    key: "daemon.goals.dailyCostUSD",
    label: "Goals, per day",
    read: (config) => config.daemon?.goals?.dailyCostUSD,
  },
  {
    key: "daemon.goals.monthlyCostUSD",
    label: "Goals, per month",
    read: (config) => config.daemon?.goals?.monthlyCostUSD,
  },
  {
    key: "daemon.dailyCostUSD",
    label: "All unattended work, per day",
    read: (config) => config.daemon?.dailyCostUSD,
  },
  {
    key: "daemon.monthlyCostUSD",
    label: "All unattended work, per month",
    read: (config) => config.daemon?.monthlyCostUSD,
  },
  {
    key: "chat.defaultCostLimitUSD",
    label: "Chat, per session (default)",
    read: (config) => config.chat?.defaultCostLimitUSD,
  },
];

export type SpendLimitInput =
  | { readonly kind: "unlimited" }
  | { readonly kind: "limit"; readonly dollars: number }
  | { readonly kind: "invalid"; readonly message: string };

const UNLIMITED_WORDS: ReadonlySet<string> = new Set(["", "none", "unlimited", "off", "0"]);

/** "5", "$5.50", "unlimited", "" (unlimited). Anything else is refused with a reason. */
export function parseSpendLimitInput(raw: string): SpendLimitInput {
  const text = raw.trim().toLowerCase();
  if (UNLIMITED_WORDS.has(text)) {
    return { kind: "unlimited" };
  }
  const amount = Number(text.replace(/^\$/, ""));
  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      kind: "invalid",
      message: "Type an amount in dollars, like 5 or 12.50, or leave it empty for unlimited.",
    };
  }
  return { kind: "limit", dollars: Math.round(amount * 100) / 100 };
}

export function describeSpendLimit(dollars: number | undefined): string {
  return dollars === undefined ? "unlimited" : `$${dollars.toFixed(2)}`;
}

/** Persist one parsed input: a limit is written, unlimited removes the key. */
export function applySpendLimit(
  configService: Pick<AgentConfigService, "set">,
  key: string,
  input: Exclude<SpendLimitInput, { kind: "invalid" }>,
): Effect.Effect<void> {
  return configService.set(key, input.kind === "limit" ? input.dollars : undefined);
}
