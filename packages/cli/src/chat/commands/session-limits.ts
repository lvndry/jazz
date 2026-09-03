/**
 * Shared logic for the /limit command: estimating this conversation's spend
 * against configured turn/USD/token caps, and gating a turn on user
 * confirmation once a cap is reached. Used both by the /limit handler itself
 * (to report an already-exceeded cap the moment it's set) and by the chat
 * loop (to gate every subsequent turn).
 */

import type { TerminalService } from "@jazz/core/interfaces/terminal";
import type { Agent } from "@jazz/core/types";
import { getModelsDevMetadata } from "@jazz/core/utils/models-dev";
import { Effect } from "effect";
import type { SessionLimits, SessionUsage } from "./types";

export type SessionLimitMetric = "turns" | "usd" | "tokens";

export const SESSION_LIMIT_FIELD: Record<SessionLimitMetric, keyof SessionLimits> = {
  turns: "maxTurns",
  usd: "maxCostUSD",
  tokens: "maxTokens",
};

export interface SessionLimitUsage {
  readonly turns: number;
  readonly costUSD: number;
  readonly tokens: number;
}

export interface SessionLimitOverage {
  readonly metric: SessionLimitMetric;
  readonly limit: number;
  readonly used: number;
}

/** Estimated USD spent so far, from accumulated tokens and model pricing (same calculation as /cost). */
export function estimateSessionCostUSD(
  sessionUsage: SessionUsage,
  agent: Agent,
): Effect.Effect<number, never, never> {
  return Effect.promise(() =>
    getModelsDevMetadata(agent.config.llmModel, agent.config.llmProvider),
  ).pipe(
    Effect.map((meta) => {
      const inputPricePerMillion = meta?.inputPricePerMillion ?? 0;
      const outputPricePerMillion = meta?.outputPricePerMillion ?? 0;
      return (
        (sessionUsage.promptTokens / 1_000_000) * inputPricePerMillion +
        (sessionUsage.completionTokens / 1_000_000) * outputPricePerMillion
      );
    }),
  );
}

export function findExceededSessionLimits(
  limits: SessionLimits,
  usage: SessionLimitUsage,
): SessionLimitOverage[] {
  const exceeded: SessionLimitOverage[] = [];
  if (limits.maxTurns !== undefined && usage.turns >= limits.maxTurns) {
    exceeded.push({ metric: "turns", limit: limits.maxTurns, used: usage.turns });
  }
  if (limits.maxCostUSD !== undefined && usage.costUSD >= limits.maxCostUSD) {
    exceeded.push({ metric: "usd", limit: limits.maxCostUSD, used: usage.costUSD });
  }
  if (limits.maxTokens !== undefined && usage.tokens >= limits.maxTokens) {
    exceeded.push({ metric: "tokens", limit: limits.maxTokens, used: usage.tokens });
  }
  return exceeded;
}

export function formatSessionLimitMetric(metric: SessionLimitMetric, value: number): string {
  switch (metric) {
    case "turns":
      return `${Math.round(value)} turn${Math.round(value) === 1 ? "" : "s"}`;
    case "usd":
      return `$${value.toFixed(2)}`;
    case "tokens":
      return `${Math.round(value).toLocaleString()} tokens`;
  }
}

/**
 * Warn about every exceeded cap and ask whether to continue. Declining does
 * not clear the limit — the next turn hits this same gate again — so raising
 * or clearing it with /limit is the only way past it.
 */
export function confirmSessionLimitOverage(
  terminal: TerminalService,
  exceeded: readonly SessionLimitOverage[],
): Effect.Effect<boolean, never, never> {
  return Effect.gen(function* () {
    for (const overage of exceeded) {
      yield* terminal.warn(
        `Session ${overage.metric} limit reached: ${formatSessionLimitMetric(overage.metric, overage.used)} used, limit ${formatSessionLimitMetric(overage.metric, overage.limit)}.`,
      );
    }
    return yield* terminal.confirm("Continue anyway?", false);
  });
}
