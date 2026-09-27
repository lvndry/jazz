/**
 * @fileoverview The notify outbox: every notification is written to disk before anything tries
 * to send it, so a send that fails is retried instead of lost.
 *
 * One versioned JSON list per target under `$JAZZ_HOME/notify/outbox/<target>.json`. Items
 * are delivered at least once with the same claim and settle rules as reminders and wake
 * triggers (`delivery.ts`): a sender claims an item under the target's lock, removes it only
 * after the target accepted it, and keeps the error, attempt count and next retry time when
 * it did not. The daemon drains every target each tick; a CLI command that queued something
 * drains before it exits, so a host without a daemon still delivers.
 *
 * Routing ({@link notifyTargets}): the `notify.targets` list, or one desktop target when it is
 * unset; desktop targets are left out while `notifications.enabled` is false. A target
 * receives every subscribable event unless its `events` list narrows it. Workflow results go
 * only to the targets a workflow's `deliver:` names. A `dedupeKey` makes an event go out at
 * most once per key (a waiting item once, a spend cap once per window).
 *
 * Usage:
 * ```ts
 * yield* enqueueNotification(notifyTargets(appConfig), event, { dedupeKey });
 * // later, in adapters: drainNotifyOutbox() sends and settles.
 * ```
 */

import * as path from "node:path";
import { Effect } from "effect";
import { z } from "zod";
import type { AppConfig } from "@/core/types/config";
import type { NotifyTarget, NotifyTargetKind } from "@/core/types/notify";
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

/** Queued items one target may hold; the oldest given-up items make room first. */
export const MAX_OUTBOX_ITEMS_PER_TARGET = 200;

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

/** On-disk shape of one target's outbox, shared with the sender in adapters. */
export const OUTBOX_FILE_KIND = recordListKind("notifications", "notifications", OutboxItemSchema);

/** `$JAZZ_HOME/notify/outbox`. */
export function outboxDirectory(home: string = getJazzHomeDirectory()): string {
  return path.join(home, "notify", "outbox");
}

export function outboxFilePath(baseDirectory: string, target: string): string {
  return path.join(baseDirectory, `${target}.json`);
}

export function outboxLockPath(baseDirectory: string, target: string): string {
  return path.join(baseDirectory, `${target}.lock`);
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

/** The one desktop target used while `notify.targets` is unset. */
const DEFAULT_TARGETS: readonly NotifyTarget[] = [{ name: "desktop", kind: "desktop" }];

/**
 * The targets notifications go to: `notify.targets`, or one desktop target when it is unset.
 * Desktop targets are dropped while `notifications.enabled` is false.
 */
export function notifyTargets(
  config: Pick<AppConfig, "notify" | "notifications">,
): readonly NotifyTarget[] {
  const targets = config.notify?.targets ?? DEFAULT_TARGETS;
  return config.notifications?.enabled === false
    ? targets.filter((target) => target.kind !== "desktop")
    : targets;
}

export interface EnqueueOptions {
  /** Targets named explicitly (a workflow's `deliver:`), on top of the subscribed ones. */
  readonly targets?: readonly string[];
  /** Leave out targets of these kinds (a reminder whose desktop notification just failed). */
  readonly excludeKinds?: readonly NotifyTargetKind[];
  /** Send this event at most once per key. */
  readonly dedupeKey?: string;
  readonly home?: string;
  readonly now?: number;
}

export interface EnqueueResult {
  /** Targets the event was queued on. */
  readonly queued: readonly string[];
  /** Targets named in `options.targets` that are not configured. */
  readonly missing: readonly string[];
  /** True when the dedupe key had already been used, so nothing was queued. */
  readonly duplicate: boolean;
}

function subscribes(target: NotifyTarget, event: NotifyEvent): boolean {
  if (event.kind === "workflow-result") {
    return false;
  }
  return target.events === undefined || target.events.includes(event.kind);
}

/** Which targets `event` goes to, and which explicitly named ones do not exist. */
export function routeNotification(
  targets: readonly NotifyTarget[],
  event: NotifyEvent,
  options: Pick<EnqueueOptions, "targets" | "excludeKinds"> = {},
): { readonly targets: readonly string[]; readonly missing: readonly string[] } {
  const excluded = new Set(options.excludeKinds ?? []);
  const chosen = new Set<string>();
  const missing: string[] = [];
  for (const target of targets) {
    if (subscribes(target, event) && !excluded.has(target.kind)) {
      chosen.add(target.name);
    }
  }
  for (const name of options.targets ?? []) {
    const target = targets.find((candidate) => candidate.name === name);
    if (target === undefined) {
      missing.push(name);
    } else if (!excluded.has(target.kind)) {
      chosen.add(target.name);
    }
  }
  return { targets: [...chosen].sort(), missing };
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
  target: string,
): Effect.Effect<OutboxItem[], Error> {
  const kept = [...items];
  while (kept.length >= MAX_OUTBOX_ITEMS_PER_TARGET) {
    const index = kept.findIndex((item) => hasStoppedRetrying(item.delivery));
    if (index === -1) {
      return Effect.fail(
        new Error(
          `The "${target}" notify outbox holds ${kept.length} undelivered notifications; check the target with \`jazz notify test ${target}\`.`,
        ),
      );
    }
    kept.splice(index, 1);
  }
  return Effect.succeed(kept);
}

function appendToTarget(
  baseDirectory: string,
  target: string,
  item: OutboxItem,
): Effect.Effect<void, Error> {
  const filePath = outboxFilePath(baseDirectory, target);
  return withLock(
    outboxLockPath(baseDirectory, target),
    Effect.gen(function* () {
      const items =
        (yield* readStateFile(filePath, OUTBOX_FILE_KIND, { onCorrupt: "quarantine" })) ?? [];
      const kept = yield* withRoomForOne(items, target);
      yield* writeStateFile(filePath, OUTBOX_FILE_KIND, [...kept, item]);
    }),
  );
}

/**
 * Queue `event` on every target it routes to. Nothing is sent here; a drain sends it. With no
 * target to send to this is a no-op that touches no file.
 */
export function enqueueNotification(
  targets: readonly NotifyTarget[],
  event: NotifyEvent,
  options: EnqueueOptions = {},
): Effect.Effect<EnqueueResult, Error> {
  return Effect.gen(function* () {
    const routed = routeNotification(targets, event, options);
    const { missing } = routed;
    if (routed.targets.length === 0) {
      return { queued: [], missing, duplicate: false };
    }
    const home = options.home ?? getJazzHomeDirectory();
    const now = options.now ?? Date.now();
    if (options.dedupeKey !== undefined && !(yield* claimDedupeKey(home, options.dedupeKey, now))) {
      return { queued: [], missing, duplicate: true };
    }
    const baseDirectory = outboxDirectory(home);
    const queued: string[] = [];
    for (const target of routed.targets) {
      yield* appendToTarget(baseDirectory, target, { id: newItemId(now), fireAt: now, event });
      queued.push(target);
    }
    return { queued, missing, duplicate: false };
  });
}
