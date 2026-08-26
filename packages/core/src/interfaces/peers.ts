import { Context, Effect } from "effect";
import type { PeerTier } from "@/core/types/peer";

/**
 * What happened to a request.
 *
 * `refused` and `expired` are distinct on purpose. A refusal is the policy doing its job and
 * is unremarkable; a parked request nobody answered is a question left hanging, which is a
 * different thing to notice when reading back.
 */
export type LedgerOutcome = "answered" | "refused" | "parked" | "expired" | "failed";

export interface LedgerEntry {
  readonly at: string;
  /** `out` — my agent asked theirs. `in` — theirs asked mine. */
  readonly direction: "in" | "out";
  readonly peer: string;
  /** The question, verbatim. Never a summary: a summary is the thing you cannot audit. */
  readonly question: string;
  /** What was actually said back, verbatim, when anything was. */
  readonly answer?: string;
  readonly outcome: LedgerOutcome;
  /** The tier in force when the decision was made, for inbound requests. */
  readonly tier?: PeerTier;
  /** Why, when the outcome was not `answered`. */
  readonly reason?: string;
}

/** A record of everything said to and by another agent. */
export interface PeerLedgerService {
  readonly record: (entry: LedgerEntry) => Effect.Effect<void, never>;
}

export const PeerLedgerServiceTag = Context.GenericTag<PeerLedgerService>("PeerLedgerService");

/** Finding a peer's bearer token. */
export interface PeerTokenService {
  readonly resolveToken: (peerName: string) => Effect.Effect<string | undefined, never>;
}

export const PeerTokenServiceTag = Context.GenericTag<PeerTokenService>("PeerTokenService");
