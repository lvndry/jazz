/**
 * The board a run's agents share. The parent and every sub-agent below it post findings the
 * others read, so siblings stop repeating each other's work without routing everything through
 * the parent's context. One board serves a whole run tree, or a chat across its turns.
 */

import type { UntrustedProvenance } from "@/core/types/tools";

/**
 * Posts one board keeps. The oldest go first past it, so a chat that delegates turn after turn
 * holds at most this many posts of at most `MAX_BLACKBOARD_POST_CHARS` each.
 */
export const MAX_BLACKBOARD_ENTRIES = 500;

/** Longest post: a finding another agent can act on. A full report is a sub-agent's answer. */
export const MAX_BLACKBOARD_POST_CHARS = 4_000;

export interface BlackboardEntry {
  /** Ascending across the board's life; a reader passes the last one it saw as `afterId`. */
  readonly id: number;
  /** Name of the agent that posted it. */
  readonly author: string;
  readonly topic: string;
  readonly content: string;
  readonly postedAt: string;
  /** Set when its author's run had read external content before posting. */
  readonly untrusted?: UntrustedProvenance;
}

export interface BlackboardRead {
  readonly entries: readonly BlackboardEntry[];
  /** Posts after `afterId` that were dropped to make room before this read reached them. */
  readonly dropped: number;
}

export interface Blackboard {
  readonly post: (input: Omit<BlackboardEntry, "id" | "postedAt">) => BlackboardEntry;
  /** Posts after `afterId` (every kept post when unset), oldest first, matching `topic` when set. */
  readonly read: (filter: { readonly afterId?: number; readonly topic?: string }) => BlackboardRead;
}

export function createBlackboard(): Blackboard {
  const entries: BlackboardEntry[] = [];
  let lastId = 0;
  return {
    post: (input) => {
      const entry: BlackboardEntry = { ...input, id: ++lastId, postedAt: new Date().toISOString() };
      entries.push(entry);
      if (entries.length > MAX_BLACKBOARD_ENTRIES) {
        entries.shift();
      }
      return entry;
    },
    read: ({ afterId = 0, topic }) => {
      const oldestKept = entries[0]?.id ?? lastId + 1;
      const dropped = Math.max(0, oldestKept - afterId - 1);
      const wanted = topic?.trim().toLowerCase();
      return {
        entries: entries.filter(
          (entry) =>
            entry.id > afterId && (wanted === undefined || entry.topic.toLowerCase() === wanted),
        ),
        dropped,
      };
    },
  };
}
