/**
 * The run caps the configuration wizard edits: the iteration budget for a top-level
 * run (`maxIterations`) and for sub-agent runs (`maxSubagentIterations`), both at the
 * top level of config.json. Each is unset by default, which means 100 / 30 on an
 * unattended run and unlimited in a terminal conversation, and clearing one restores
 * that behavior.
 *
 * `parseRunLimitInput` reads what a person typed; `applyRunLimit` writes it (or removes
 * the key, for the default) through the config service, so the wizard and its tests
 * share one rule.
 */

import type { AgentConfigService } from "@jazz/core/interfaces/agent-config";
import type { AppConfig } from "@jazz/core/types/config";
import { Effect } from "effect";

export interface RunLimitSetting {
  readonly key: string;
  readonly label: string;
  readonly read: (config: AppConfig) => number | undefined;
}

/** The top-level run comes first, then its sub-agents. */
export const RUN_LIMIT_SETTINGS: readonly RunLimitSetting[] = [
  {
    key: "maxIterations",
    label: "Top-level run, max iterations",
    read: (config) => config.maxIterations,
  },
  {
    key: "maxSubagentIterations",
    label: "Sub-agents, max iterations",
    read: (config) => config.maxSubagentIterations,
  },
];

export type RunLimitInput =
  | { readonly kind: "default" }
  | { readonly kind: "limit"; readonly iterations: number }
  | { readonly kind: "invalid"; readonly message: string };

const DEFAULT_WORDS: ReadonlySet<string> = new Set(["", "none", "default"]);

/** "500", "default", "" (default). Anything else is refused with a reason. */
export function parseRunLimitInput(raw: string): RunLimitInput {
  const text = raw.trim().toLowerCase();
  if (DEFAULT_WORDS.has(text)) {
    return { kind: "default" };
  }
  const iterations = Number(text);
  if (!Number.isInteger(iterations) || iterations < 1) {
    return {
      kind: "invalid",
      message: "Type a whole number of iterations, like 500, or leave it empty for the default.",
    };
  }
  return { kind: "limit", iterations };
}

export function describeRunLimit(iterations: number | undefined): string {
  return iterations === undefined ? "default" : `${String(iterations)}`;
}

/** Persist one parsed input: a limit is written, the default removes the key. */
export function applyRunLimit(
  configService: Pick<AgentConfigService, "set">,
  key: string,
  input: Exclude<RunLimitInput, { kind: "invalid" }>,
): Effect.Effect<void> {
  return configService.set(key, input.kind === "limit" ? input.iterations : undefined);
}
