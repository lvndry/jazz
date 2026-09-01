/**
 * @fileoverview Turning fresh inbound ledger entries into one footer-sized notice.
 *
 * Pure on purpose: the polling itself (reading the ledger, remembering what has already been
 * surfaced) lives in `App.tsx`, next to the rest of the fullscreen session's side effects.
 * This is just the part worth testing without a filesystem.
 */

import type { LedgerEntry } from "@jazz/core/interfaces/peers";

export interface PeerNoticeResult {
  /** A one-line notice for the footer, or undefined when nothing unseen arrived. */
  readonly notice: string | undefined;
  /**
   * The newest inbound `at` seen this poll, to persist as the new cursor. Present even when
   * `notice` is undefined but inbound entries exist, so a session that starts after messages
   * have already been read elsewhere does not replay them the moment it starts polling.
   */
  readonly newestInboundAt: string | undefined;
}

/**
 * `entries` is newest-first (as `ledger.read()` returns it) and unfiltered by direction —
 * only `direction: "in"` ever produces a notice, since an outbound `ask_peer` call is
 * something this session's own operator just did, not news to surface back at them.
 */
export function computePeerNotice(
  entries: readonly LedgerEntry[],
  lastSeenAt: string | undefined,
): PeerNoticeResult {
  const inbound = entries.filter((entry) => entry.direction === "in");
  if (inbound.length === 0) return { notice: undefined, newestInboundAt: undefined };

  const newestInboundAt = inbound[0]?.at;
  const unseen =
    lastSeenAt === undefined ? inbound : inbound.filter((entry) => entry.at > lastSeenAt);
  if (unseen.length === 0) return { notice: undefined, newestInboundAt };

  const distinctPeers = [...new Set(unseen.map((entry) => entry.peer))];
  const notice =
    unseen.length === 1
      ? `${unseen[0]?.peer ?? "a peer"} asked something — jazz peers log`
      : distinctPeers.length === 1
        ? `${String(unseen.length)} new from ${distinctPeers[0]} — jazz peers log`
        : `${String(unseen.length)} new peer messages — jazz peers log`;

  return { notice, newestInboundAt };
}
