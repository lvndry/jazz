/**
 * @fileoverview Someone else's agent, and how much of your life it may see.
 *
 * A peer is another agent — a friend's jazz, or anything else that answers questions over
 * HTTP. Two properties make this unlike every other trust decision in the product.
 *
 * First, **authentication is not authorization**. Knowing a request really came from Sam's
 * agent says nothing about whether Sam asked it, whether their agent invented the question,
 * or whether something it read an hour ago told it to. There is no way to tell those apart,
 * and a design that pretends otherwise is the dangerous kind.
 *
 * Second, **the risk is disclosure, not damage**. Every other approval in jazz asks what a
 * tool can do to this machine. A peer asking questions does nothing to the machine at all;
 * what it costs you is what it learns. That is why {@link ToolDisclosure} exists as an axis
 * separate from `riskLevel`, and why tiers here are expressed in those terms.
 */

/** How much a peer's agent may learn, expressed in {@link ToolDisclosure} terms. */
export type PeerTier =
  /** Configured but answering nothing. The default, and what revoking a peer sets. */
  | "none"
  /** Only `none`-disclosure answers: nothing about the operator or their machine. */
  | "public"
  /** Adds `context`: paths, names, what is installed. Not file contents. */
  | "about-me"
  /** Adds `personal`, but still read-only. The most a peer can ever be given. */
  | "ask-me-anything";

export const PEER_TIERS: readonly PeerTier[] = ["none", "public", "about-me", "ask-me-anything"];

export function isPeerTier(value: string): value is PeerTier {
  return (PEER_TIERS as readonly string[]).includes(value);
}

export interface PeerConfig {
  /** Local name, used in commands and in the ledger. Unique. */
  readonly name: string;
  /** Where the peer's agent answers. Its token lives in the keyring, never here. */
  readonly url: string;
  /**
   * What this peer may learn. Absent means {@link PeerTier} `none`: a peer that was added
   * but never granted anything answers nothing, rather than defaulting to something.
   */
  readonly may?: PeerTier;
}

/**
 * No tier permits a peer to cause anything.
 *
 * Not a gap to be filled later — a line. A remote agent that could write a file, run a
 * command or send a message would put the blast radius of somebody else's compromised
 * assistant on this machine, and "their agent books the restaurant" is not worth that.
 * Where an action is genuinely wanted, it goes through a human, never through a tier.
 */
export const PEER_TIER_MAX_RISK = "read-only" as const;
