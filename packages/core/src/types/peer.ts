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
  /**
   * Where the peer's agent answers, if this machine can ask them at all. Its token lives in
   * the keyring, never here.
   *
   * Optional because `url` and `may` are two independent capabilities — "I can ask them" and
   * "they can ask me" — that happen to share one config record. A peer added only so it can
   * ask *you* (the common case a one-way invite produces) has a `may` and no `url`; a peer
   * you can ask but who has not reciprocally granted you anything has a `url` and no `may`.
   * Both set is a fully mutual relationship. Neither set is a name with nothing behind it.
   */
  readonly url?: string;
  /**
   * What this peer may learn. Absent means {@link PeerTier} `none`: a peer that was added
   * but never granted anything answers nothing, rather than defaulting to something.
   *
   * This is disclosure only — what an answer reveals. It says nothing about what the
   * answering agent can *do*; that is {@link PersonaToolProfile}, fixed on whichever persona
   * answers this peer, the same for every peer who reaches it. See `allow` for the one place
   * those two axes meet.
   */
  readonly may?: PeerTier;
  /**
   * Which persona/agent answers this peer. Absent falls back to the daemon's default
   * `--serve-peers` agent, so existing configs keep working unchanged.
   *
   * This is how two peers can get genuinely different treatment from the same operator
   * without a second config surface: point a peer at a persona built for that relationship
   * (a work contact gets a narrower persona than a partner) instead of inventing per-peer
   * scope strings.
   */
  readonly persona?: string;
  /**
   * Tool names this specific peer may invoke beyond read-only risk.
   *
   * Capability (what the persona *can* do) is never a per-peer grant — but a persona is
   * allowed to be capable of real actions, and when one is, not every peer who reaches it
   * should inherit those actions just because disclosure was opened up. A tool riskier than
   * read-only stays gated by this explicit allowlist regardless of `may`: absent or empty
   * means read-only only, and a tool not listed here is never offered to this peer's agent
   * at all — refused by absence, the same as any other capability it doesn't have. Widening
   * it is a deliberate config edit, not something a question can negotiate its way into.
   */
  readonly allow?: readonly string[];
}
