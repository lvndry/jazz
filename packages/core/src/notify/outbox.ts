/**
 * @fileoverview The notify outbox: every notification is written to disk before anything tries
 * to send it, so a send that fails is retried instead of lost.
 *
 * One versioned JSON list per channel under `$JAZZ_HOME/notify/outbox/<channel>.json`. Items
 * are delivered at least once with the same claim and settle rules as reminders and wake
 * triggers (`delivery.ts`): a sender claims an item under the channel's lock, removes it only
 * after the channel accepted it, and keeps the error, attempt count and next retry time when
 * it did not. The daemon drains every channel each tick; a CLI command that queued something
 * drains before it exits, so a host without a daemon still delivers.
 *
 * Routing: a channel receives every subscribable event unless its `events` list narrows it.
 * Workflow results go only to the channels a workflow's `deliver:` names. A `dedupeKey` makes
 * an event go out at most once per key (a spend ceiling once per window, not once per refused
 * run).
 *
 * Usage:
 * ```ts
 * yield* enqueueNotification(appConfig.notifications?.channels, event, { dedupeKey });
 * // later, in adapters: drainNotifyOutbox() sends and settles.
 * ```
 */

import * as path from "node:path";
import { Effect } from "effect";
import { z } from "zod";
import type { NotifyChannelConfig, NotifyChannelType } from "@/core/types/notify";
import { DeliveryStateSchema, type DeliveryState, hasStoppedRetrying } from "@/core/utils/delivery";
import { getJazzHomeDirectory } from "@/core/utils/paths";
import {
  readStateFile,
  recordListKind,
  type StateFileKind,
  writeStateFile,
} from "@/core/utils/state-file";
import { withLock } from "@/core/utils/storage";
import { type NotifyEvent, NotifyEventSchema } from "./events";

/** Queued items one channel may hold; the oldest given-up items make room first. */
export const MAX_OUTBOX_ITEMS_PER_CHANNEL = 200;

/** How long a dedupe key is remembered: longer than the longest window (a month). */
const DEDUPE_RETENTION_MS = 40 * 24 * 60 * 60_000;

export interface OutboxItem {
  readonly id: string;
  /** When it was queued; due immediately. Named for the shared scheduled-item claim rules. */
  readonly fireAt: number;
  readonly event: NotifyEvent;
  readonly delivery?: DeliveryState;
}

const OutboxItemSchema: z.ZodType<OutboxItem> = z.object({
  id: z.string(),
  fireAt: z.number(),
  event: NotifyEventSchema,
  delivery: DeliveryStateSchema.exactOptional(),
});

/** On-disk shape of one channel's outbox, shared with the sender in adapters. */
export const OUTBOX_FILE_KIND = recordListKind("notifications", "notifications", OutboxItemSchema);

/** `$JAZZ_HOME/notify/outbox`. */
export function outboxDirectory(home: string = getJazzHomeDirectory()): string {
  return path.join(home, "notify", "outbox");
}

export function outboxFilePath(baseDirectory: string, channel: string): string {
  return path.join(baseDirectory, `${channel}.json`);
}

export function outboxLockPath(baseDirectory: string, channel: string): string {
  return path.join(baseDirectory, `${channel}.lock`);
}

type DedupeLog = Readonly<Record<string, number>>;

const DEDUPE_KIND: StateFileKind<DedupeLog> = {
  noun: "notification dedupe log",
  schemaVersion: 1,
  parse: (document) => {
    const parsed = z.object({ sent: z.record(z.string(), z.number()) }).safeParse(document);
    return parsed.success
      ? { ok: true, content: parsed.data.sent }
      : { ok: false, error: parsed.error.message };
  },
  serialize: (sent) => ({ sent }),
};

function dedupePath(home: string): string {
  return path.join(home, "notify", "sent.json");
}

export interface EnqueueOptions {
  /** Channels named explicitly (a workflow's `deliver:`), on top of the subscribed ones. */
  readonly channels?: readonly string[];
  /** Leave out channels of these types (a reminder whose desktop notification just failed). */
  readonly excludeTypes?: readonly NotifyChannelType[];
  /** Send this event at most once per key. */
  readonly dedupeKey?: string;
  readonly home?: string;
  readonly now?: number;
}

export interface EnqueueResult {
  /** Channels the event was queued on. */
  readonly queued: readonly string[];
  /** Channels named in `options.channels` that are not configured. */
  readonly missing: readonly string[];
  /** True when the dedupe key had already been used, so nothing was queued. */
  readonly duplicate: boolean;
}

function subscribes(channel: NotifyChannelConfig, event: NotifyEvent): boolean {
  if (event.kind === "workflow-result") {
    return false;
  }
  return channel.events === undefined || channel.events.includes(event.kind);
}

/** Which configured channels `event` goes to, and which explicitly named ones do not exist. */
export function routeNotification(
  channels: Readonly<Record<string, NotifyChannelConfig>> | undefined,
  event: NotifyEvent,
  options: Pick<EnqueueOptions, "channels" | "excludeTypes"> = {},
): { readonly targets: readonly string[]; readonly missing: readonly string[] } {
  const configured = channels ?? {};
  const excluded = new Set(options.excludeTypes ?? []);
  const targets = new Set<string>();
  const missing: string[] = [];
  for (const [name, channel] of Object.entries(configured)) {
    if (subscribes(channel, event) && !excluded.has(channel.type)) {
      targets.add(name);
    }
  }
  for (const name of options.channels ?? []) {
    const channel = configured[name];
    if (channel === undefined) {
      missing.push(name);
    } else if (!excluded.has(channel.type)) {
      targets.add(name);
    }
  }
  return { targets: [...targets].sort(), missing };
}

function newItemId(now: number): string {
  return `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Claim a dedupe key; false when it was already used. Prunes keys past their retention. */
function claimDedupeKey(home: string, key: string, now: number): Effect.Effect<boolean, Error> {
  const filePath = dedupePath(home);
  return withLock(
    `${filePath}.lock`,
    Effect.gen(function* () {
      const sent = (yield* readStateFile(filePath, DEDUPE_KIND, { onCorrupt: "quarantine" })) ?? {};
      if (sent[key] !== undefined) {
        return false;
      }
      const next: Record<string, number> = { [key]: now };
      for (const [existing, at] of Object.entries(sent)) {
        if (now - at < DEDUPE_RETENTION_MS) {
          next[existing] = at;
        }
      }
      yield* writeStateFile(filePath, DEDUPE_KIND, next);
      return true;
    }),
  );
}

/** Make room for one more item: drop the oldest items that stopped retrying, then refuse. */
function withRoomForOne(
  items: readonly OutboxItem[],
  channel: string,
): Effect.Effect<OutboxItem[], Error> {
  const kept = [...items];
  while (kept.length >= MAX_OUTBOX_ITEMS_PER_CHANNEL) {
    const index = kept.findIndex((item) => hasStoppedRetrying(item.delivery));
    if (index === -1) {
      return Effect.fail(
        new Error(
          `The "${channel}" notify outbox holds ${kept.length} undelivered notifications; check the channel with \`jazz notify test ${channel}\`.`,
        ),
      );
    }
    kept.splice(index, 1);
  }
  return Effect.succeed(kept);
}

function appendToChannel(
  baseDirectory: string,
  channel: string,
  item: OutboxItem,
): Effect.Effect<void, Error> {
  const filePath = outboxFilePath(baseDirectory, channel);
  return withLock(
    outboxLockPath(baseDirectory, channel),
    Effect.gen(function* () {
      const items =
        (yield* readStateFile(filePath, OUTBOX_FILE_KIND, { onCorrupt: "quarantine" })) ?? [];
      const kept = yield* withRoomForOne(items, channel);
      yield* writeStateFile(filePath, OUTBOX_FILE_KIND, [...kept, item]);
    }),
  );
}

/**
 * Queue `event` on every channel it routes to. Nothing is sent here; a drain sends it. With no
 * channel configured this is a no-op that touches no file.
 */
export function enqueueNotification(
  channels: Readonly<Record<string, NotifyChannelConfig>> | undefined,
  event: NotifyEvent,
  options: EnqueueOptions = {},
): Effect.Effect<EnqueueResult, Error> {
  return Effect.gen(function* () {
    const { targets, missing } = routeNotification(channels, event, options);
    if (targets.length === 0) {
      return { queued: [], missing, duplicate: false };
    }
    const home = options.home ?? getJazzHomeDirectory();
    const now = options.now ?? Date.now();
    if (options.dedupeKey !== undefined && !(yield* claimDedupeKey(home, options.dedupeKey, now))) {
      return { queued: [], missing, duplicate: true };
    }
    const baseDirectory = outboxDirectory(home);
    const queued: string[] = [];
    for (const channel of targets) {
      yield* appendToChannel(baseDirectory, channel, { id: newItemId(now), fireAt: now, event });
      queued.push(channel);
    }
    return { queued, missing, duplicate: false };
  });
}
