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

/**
 * How much a peer's agent may learn — literally the {@link ToolDisclosure} levels a tool's
 * own answer can carry, plus `none` for a peer granted nothing at all. Not a separate,
 * friendlier vocabulary: the tier a peer holds directly names the disclosure ceiling it
 * admits, so nothing here can be misread as describing risk or permission to act (see
 * `PeerConfig.allow` for that entirely separate axis).
 */
export type PeerTier =
  /** Configured but answering nothing. The default, and what revoking a peer sets. */
  | "none"
  /** Only `public`-disclosure answers: nothing about the operator or their machine. */
  | "public"
  /** Adds `internal`: paths, names, what is installed. Not file contents. */
  | "internal"
  /** Adds `private`, but still read-only. The most a peer can ever be given. */
  | "private";

export const PEER_TIERS: readonly PeerTier[] = ["none", "public", "internal", "private"];

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
   * Optional because `url` and `disclosure` are two independent capabilities — "I can ask
   * them" and "they can ask me" — that happen to share one config record. A peer added only
   * so it can ask *you* (the common case a one-way invite produces) has a `disclosure` and no
   * `url`; a peer you can ask but who has not reciprocally granted you anything has a `url`
   * and no `disclosure`. Both set is a fully mutual relationship. Neither set is a name with
   * nothing behind it.
   */
  readonly url?: string;
  /**
   * What this peer may learn. Absent means {@link PeerTier} `none`: a peer that was added
   * but never granted anything answers nothing, rather than defaulting to something.
   *
   * This is disclosure only — what an answer reveals. It says nothing about what the
   * answering agent can *do*; capability is fixed by which agent an operator runs
   * `jazz daemon --serve-peers` with, the same for every peer who reaches it — not a
   * per-peer setting at all. See `allow` for the one place these two axes meet.
   */
  readonly disclosure?: PeerTier;
  /**
   * Which persona answers this peer — a mindset (system prompt, tone, style), nothing more.
   * Absent falls back to the serving agent's own configured persona, so existing configs
   * keep working unchanged.
   *
   * This is voice only. It carries no capability meaning: swapping a peer's persona cannot
   * widen or narrow what the serving agent can *do* (that stays fixed — see `disclosure`).
   * It's how the same underlying agent can sound different to different people — more formal
   * with a work contact, warmer with a partner — without needing a second config surface to
   * say so.
   */
  readonly persona?: string;
  /**
   * Tool names this specific peer may invoke beyond read-only risk.
   *
   * Capability is fixed once, by the operator's choice of which agent answers peers at all —
   * never a per-peer grant, and never widened by `disclosure` or `persona`. But that agent is
   * allowed to be capable of real actions, and when it is, not every peer who reaches it
   * should inherit those actions just because disclosure was opened up. A tool riskier than
   * read-only stays gated by this explicit allowlist regardless of tier: absent or empty
   * means read-only only, and a tool not listed here is never offered to this peer's agent
   * at all — refused by absence, the same as any other capability it doesn't have. Widening
   * it is a deliberate config edit, not something a question can negotiate its way into.
   *
   * `"request_clarification"` is the one entry here that grants nothing about the machine:
   * it only lets the serving agent decline to answer this peer immediately and ask them
   * something back first. Still gated the same way as any other non-read-only tool, since an
   * unlisted peer should not even discover that declining-and-asking is an option.
   */
  readonly allow?: readonly string[];
}
