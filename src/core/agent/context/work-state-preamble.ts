import { Effect } from "effect";
import type { ChatMessage } from "@/core/types/message";
import { DEFAULT_TOKEN_COUNTER, type ModelHint } from "./token-counter";
import { readJournal } from "./work-journal";

/**
 * Rebuild what a previous session compacted away, for a conversation being resumed.
 *
 * Resuming loads persisted *messages*, which for a run that compacted are the
 * post-compaction messages — everything compaction dropped is already gone. The journal
 * is the only surviving record of it, so a resumed conversation that ignores the journal
 * starts blind to work it actually did.
 *
 * Framed as a claim to verify rather than as fact: a progress record is written by an
 * agent mid-task and is habitually optimistic about what was finished.
 */

/** Ceiling on the preamble, so restoring context cannot itself consume the window. */
export const WORK_STATE_PREAMBLE_TOKEN_BUDGET = 2_000;

export interface WorkStatePreambleOptions {
  readonly modelHint: ModelHint;
  readonly tokenBudget?: number;
}

/**
 * Returns a single message summarizing prior sessions, or `undefined` when there is
 * nothing recorded — in which case resume behaves exactly as it did before.
 */
export function buildWorkStatePreamble(
  agentId: string,
  conversationId: string,
  options: WorkStatePreambleOptions,
): Effect.Effect<ChatMessage | undefined, never, never> {
  return readJournal(agentId, conversationId).pipe(
    Effect.map((entries) => {
      if (entries.length === 0) return undefined;

      const budget = options.tokenBudget ?? WORK_STATE_PREAMBLE_TOKEN_BUDGET;

      // Newest first: the most recent state is the most useful, and older entries are
      // dropped when the budget runs out rather than truncating the recent one.
      const kept: string[] = [];
      let usedTokens = 0;
      for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];
        if (!entry) continue;
        const block = `### Session record ${index + 1} (${entry.recordedAt})\n\n${entry.summary}`;
        const tokens = DEFAULT_TOKEN_COUNTER.countText(block, options.modelHint);
        if (kept.length > 0 && usedTokens + tokens > budget) break;
        kept.unshift(block);
        usedTokens += tokens;
      }

      const omitted = entries.length - kept.length;
      const omittedNote =
        omitted > 0 ? `\n\n(${omitted} earlier record(s) omitted to stay within budget.)` : "";

      return {
        role: "assistant",
        content:
          "## Recovered context from earlier in this conversation\n\n" +
          "History before this point was compacted away. These are the records written at " +
          "the time. Treat them as claims to verify, not as established fact — check the " +
          "current state before relying on anything reported as finished.\n\n" +
          kept.join("\n\n") +
          omittedNote,
      } satisfies ChatMessage;
    }),
  );
}
