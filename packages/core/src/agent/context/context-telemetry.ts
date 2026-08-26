import { Effect } from "effect";
import type { LoggerService } from "@/core/interfaces/logger";

/**
 * Which rung of the context ladder fired.
 *
 * The ladder escalates by cost: `clear` discards raw tool output for free,
 * `compact` spends an LLM call to summarize, `trim` drops messages unsummarized
 * as a last resort. Logging them under one event name makes the ladder legible —
 * "how often does this agent reach compaction, and does clearing reduce it?" is a
 * question you cannot answer from three unrelated log lines.
 */
export type ContextRung = "clear" | "compact" | "trim";

export interface ContextRungEvent {
  readonly rung: ContextRung;
  readonly agentId: string;
  readonly conversationId: string;
  /** Total request tokens before the rung ran, including per-request overhead. */
  readonly tokensBefore: number;
  /** Total request tokens after it ran. */
  readonly tokensAfter: number;
  readonly budgetTokens: number;
  readonly messagesBefore: number;
  readonly messagesAfter: number;
}

/** Emit one structured record for a rung firing. */
export function logContextRung(
  logger: LoggerService,
  event: ContextRungEvent,
): Effect.Effect<void, never, never> {
  const reclaimed = event.tokensBefore - event.tokensAfter;
  return logger.info("Context rung fired", {
    ...event,
    tokensReclaimed: reclaimed,
    percentOfBudgetBefore:
      event.budgetTokens > 0 ? Math.round((event.tokensBefore / event.budgetTokens) * 100) : 0,
    percentOfBudgetAfter:
      event.budgetTokens > 0 ? Math.round((event.tokensAfter / event.budgetTokens) * 100) : 0,
  });
}
