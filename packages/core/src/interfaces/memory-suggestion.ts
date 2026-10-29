/**
 * What background passes want to change in memory, waiting for the person to keep or ignore it.
 *
 * Three kinds share one queue so the person reviews them together:
 * - a fact suggestion is a memory write whose quote was already checked against the user's
 *   own words, held back until the person keeps it, because the pass chose what to save
 *   without the person watching;
 * - a lesson is a rule an agent drew from its own mistake, in the agent's wording, so it
 *   never reaches memory on the agent's say-so;
 * - a revision removes an entry that is duplicated, contradicted or stale, or rewrites a
 *   lesson, as `/learn` proposes after reviewing the store; it quotes no one, so only the
 *   person's keep authorizes it.
 *
 * Nothing in the queue is memory yet. Only a command the person types can keep a suggestion;
 * no tool can.
 */

export interface LessonProposalInput {
  /** File name for the entry once accepted, in a few words. */
  readonly subject: string;
  /** What to do from now on, stated as a general rule. */
  readonly rule: string;
  /** What went wrong that the rule prevents. */
  readonly mistake: string;
  /** The situation the rule applies to, as a `when/<topic>/` segment, or `always`. */
  readonly topic: string;
  readonly scope: string;
  readonly proposedBy: string;
  readonly conversationId?: string;
}

/**
 * A verified write, replayed as-is when kept. An amendment records the entry it replaces, so
 * keeping it after the entry changed fails instead of overwriting the newer text.
 */
export type SuggestedMemoryChange =
  | { readonly command: "create"; readonly path: string; readonly content: string }
  | {
      readonly command: "amend";
      readonly path: string;
      readonly previousContent: string;
      readonly content: string;
    };

export interface FactSuggestionInput {
  readonly change: SuggestedMemoryChange;
  /** The user's words the change quotes, one quote per line. */
  readonly quote: string;
  /** Keys of the quoted user sentences, so a later correction or forget still revokes them. */
  readonly quotedSentenceKeys: readonly string[];
  readonly proposedBy: string;
  readonly conversationId?: string;
}

/**
 * A change to an existing entry, recorded against the content it was proposed for, so keeping it
 * after the entry changed fails instead of removing or overwriting the newer text.
 */
export type SuggestedMemoryRevision =
  | { readonly command: "delete"; readonly path: string; readonly previousContent: string }
  | {
      readonly command: "rewrite";
      readonly path: string;
      readonly previousContent: string;
      readonly content: string;
    };

export interface RevisionSuggestionInput {
  readonly change: SuggestedMemoryRevision;
  /** Why the entry should go or change, shown in review. */
  readonly reason: string;
  readonly proposedBy: string;
  readonly conversationId?: string;
}

interface QueuedSuggestion {
  /** Short id the person types to keep or ignore it. */
  readonly id: string;
  /** ISO 8601. */
  readonly proposedAt: string;
}

export interface LessonProposal extends LessonProposalInput, QueuedSuggestion {
  readonly kind: "lesson";
}

export interface FactSuggestion extends FactSuggestionInput, QueuedSuggestion {
  readonly kind: "fact";
}

export interface RevisionSuggestion extends RevisionSuggestionInput, QueuedSuggestion {
  readonly kind: "revision";
}

export type MemorySuggestion = LessonProposal | FactSuggestion | RevisionSuggestion;

export type MemorySuggestionOutcome<Suggestion extends MemorySuggestion = MemorySuggestion> =
  | { readonly success: true; readonly message: string; readonly suggestion: Suggestion }
  | { readonly success: false; readonly message: string };

export type MemorySuggestionResolution =
  | { readonly success: true; readonly message: string; readonly path?: string }
  | { readonly success: false; readonly message: string };
