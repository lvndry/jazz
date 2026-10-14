/**
 * Lessons an agent drew from its own mistakes, waiting for the person to accept or reject them.
 *
 * Memory otherwise holds only words the user wrote, quoted exactly, so nothing a web page or a
 * model says can become a standing instruction. A lesson is the one thing written in the agent's
 * own words, so it never reaches memory on the agent's say-so: it waits here until the person
 * accepts it with a command they type, and no tool can accept one.
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

export interface LessonProposal extends LessonProposalInput {
  /** Short id the person types to accept or reject it. */
  readonly id: string;
  /** ISO 8601. */
  readonly proposedAt: string;
}

export type LessonProposalOutcome =
  | { readonly success: true; readonly message: string; readonly proposal: LessonProposal }
  | { readonly success: false; readonly message: string };

export type LessonResolutionOutcome =
  | { readonly success: true; readonly message: string; readonly path?: string }
  | { readonly success: false; readonly message: string };
