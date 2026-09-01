/**
 * @fileoverview A record of everything said to and by another agent.
 *
 * Not telemetry, and not a debug log. The question this exists to answer is "what has Sam's
 * agent learned about me", and no amount of policy design substitutes for being able to
 * look. It records both directions, because what my agent volunteers on the way out is at
 * least as disclosing as what a peer manages to ask for.
 *
 * Append-only JSONL, one entry per line, unparseable lines skipped — the same discipline as
 * the conversation log, and for the same reason: a process killed mid-write should cost the
 * last entry, not the file.
 *
 * Written before anything can talk to a peer, deliberately. A ledger added after the first
 * request is a ledger with a hole at the beginning.
 */

import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import {
  PeerLedgerServiceTag,
  type LedgerEntry,
  type PeerLedgerService,
} from "@jazz/core/interfaces/peers";
import { getJazzHomeDirectory } from "@jazz/core/utils/paths";
import { Effect, Layer } from "effect";

export type { LedgerEntry, LedgerOutcome } from "@jazz/core/interfaces/peers";

const LEDGER_FILENAME = "ledger.jsonl";

/** Directory holding peer state. Separate from history: this is about other people's agents. */
export function getPeersDirectory(): string {
  return path.join(getJazzHomeDirectory(), "peers");
}

export function ledgerPath(): string {
  return path.join(getPeersDirectory(), LEDGER_FILENAME);
}

function serialize(entry: LedgerEntry): string {
  return `${JSON.stringify(entry)}\n`;
}

/**
 * Append one entry.
 *
 * Failure is swallowed, matching every other logging path in the product: losing a ledger
 * line must not fail the request that produced it. The tradeoff is real and uncomfortable —
 * a full disk or a read-only home produces silent gaps in the one record whose value is
 * being complete. Nothing here detects that yet.
 */
export function record(entry: LedgerEntry): Effect.Effect<void, never> {
  return Effect.tryPromise({
    try: async () => {
      await nodeFs.mkdir(getPeersDirectory(), { recursive: true });
      const line = serialize(entry);
      await nodeFs.appendFile(ledgerPath(), (await endsMidLine()) ? `\n${line}` : line, "utf-8");
    },
    catch: (error) => error,
  }).pipe(Effect.catchAll(() => Effect.void));
}

export function createPeerLedgerServiceLayer(): Layer.Layer<PeerLedgerService> {
  return Layer.succeed(PeerLedgerServiceTag, { record });
}

/**
 * Whether the last write was cut off mid-line.
 *
 * A process killed mid-append leaves a line with no terminator. Appending straight onto it
 * would splice the next entry into the broken one and lose both, so the truncated line is
 * closed first — the same guard the conversation log uses. One byte is read rather than the
 * file, because a ledger grows without bound and this runs on every entry.
 */
async function endsMidLine(): Promise<boolean> {
  let handle;
  try {
    handle = await nodeFs.open(ledgerPath(), "r");
    const { size } = await handle.stat();
    if (size === 0) return false;
    const tail = Buffer.alloc(1);
    await handle.read(tail, 0, 1, size - 1);
    return tail.toString("utf-8") !== "\n";
  } catch {
    // No file yet, or unreadable: either way there is no partial line to close.
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseLine(line: string): LedgerEntry | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const entry = parsed as LedgerEntry;
    if (typeof entry.peer !== "string" || typeof entry.question !== "string") return undefined;
    return entry;
  } catch {
    return undefined;
  }
}

/** Entries newest first, optionally for one peer. */
export function read(filter?: {
  readonly peer?: string;
  readonly limit?: number;
}): Effect.Effect<readonly LedgerEntry[], never> {
  return Effect.tryPromise({
    try: () => nodeFs.readFile(ledgerPath(), "utf-8"),
    catch: (error) => error,
  }).pipe(
    Effect.map((content) => {
      const entries: LedgerEntry[] = [];
      for (const line of content.split("\n")) {
        const entry = parseLine(line);
        if (entry === undefined) continue;
        if (filter?.peer !== undefined && entry.peer !== filter.peer) continue;
        entries.push(entry);
      }
      entries.reverse();
      return filter?.limit === undefined ? entries : entries.slice(0, filter.limit);
    }),
    Effect.catchAll(() => Effect.succeed([] as readonly LedgerEntry[])),
  );
}

const LAST_SEEN_FILENAME = "last-seen.json";

function lastSeenPath(): string {
  return path.join(getPeersDirectory(), LAST_SEEN_FILENAME);
}

/**
 * The `at` of the newest inbound entry a live session has already surfaced a notification
 * for, if any.
 *
 * A file of its own rather than a field on the ledger itself: "has the operator already been
 * told about this" is state about notifying, not about what a peer said, and conflating the
 * two would mean rewriting ledger lines just to mark them seen — the one file this module
 * treats as append-only stays that way.
 */
export function readLastSeenInboundAt(): Effect.Effect<string | undefined, never> {
  return Effect.tryPromise({
    try: () => nodeFs.readFile(lastSeenPath(), "utf-8"),
    catch: (error) => error,
  }).pipe(
    Effect.map((content) => {
      const parsed: unknown = JSON.parse(content);
      if (typeof parsed !== "object" || parsed === null) return undefined;
      const at = (parsed as Record<string, unknown>)["at"];
      return typeof at === "string" ? at : undefined;
    }),
    Effect.catchAll(() => Effect.succeed(undefined)),
  );
}

export function recordLastSeenInboundAt(at: string): Effect.Effect<void, never> {
  return Effect.tryPromise({
    try: async () => {
      await nodeFs.mkdir(getPeersDirectory(), { recursive: true });
      await nodeFs.writeFile(lastSeenPath(), JSON.stringify({ at }), "utf-8");
    },
    catch: (error) => error,
  }).pipe(Effect.catchAll(() => Effect.void));
}
