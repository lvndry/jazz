/**
 * The spend-limit settings the configuration wizard edits: a day and a month ceiling for goal
 * work (goal cycles and loops), and for every run on this machine. Each is unlimited until set,
 * and clearing one makes it unlimited again.
 *
 * `parseSpendLimitInput` reads what a person typed; `applySpendLimit` writes it (or removes the
 * key, for unlimited) through the config service, so the wizard and its tests share one rule.
 */

import type { AgentConfigService } from "@jazz/core/interfaces/agent-config";
import type { SpendConfig } from "@jazz/core/types/spend";
import { Effect } from "effect";

export interface SpendLimitSetting {
  readonly key: string;
  readonly label: string;
  readonly read: (spend: SpendConfig | undefined) => number | undefined;
}

/** Goal ceilings come first: they are the ones the owner asked the wizard to offer. */
export const SPEND_LIMIT_SETTINGS: readonly SpendLimitSetting[] = [
  { key: "spend.goals.dayUSD", label: "Goals, per day", read: (spend) => spend?.goals?.dayUSD },
  {
    key: "spend.goals.monthUSD",
    label: "Goals, per month",
    read: (spend) => spend?.goals?.monthUSD,
  },
  { key: "spend.dayUSD", label: "Every run, per day", read: (spend) => spend?.dayUSD },
  { key: "spend.monthUSD", label: "Every run, per month", read: (spend) => spend?.monthUSD },
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
