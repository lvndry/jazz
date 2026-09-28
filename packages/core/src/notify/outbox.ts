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
 * most once per key and target (a waiting item once, a spend cap once per window); the key is
 * spent on a target only once the event is on that target's queue.
 *
 * The implicit desktop target (the one used while `notify.targets` is unset) is skipped on a
 * host with no desktop notifier, so a headless host does not queue what it can never show.
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
import { NotificationServiceTag } from "@/core/interfaces/notification";
import type { AppConfig } from "@/core/types/config";
import type { NotifyTarget, NotifyTargetKind } from "@/core/types/notify";
import { DeliveryStateSchema, type DeliveryState, hasStoppedRetrying } from "@/core/utils/delivery";
import { isRecord } from "@/core/utils/is-record";
import { getJazzHomeDirectory } from "@/core/utils/paths";
import { readStateFile, type StateFileKind, writeStateFile } from "@/core/utils/state-file";
import { withLock } from "@/core/utils/storage";
import { type NotifyEvent, NotifyEventSchema, upgradeStoredNotifyEvent } from "./events";

/** Queued items one target may hold; the oldest given-up items make room first. */
export const MAX_OUTBOX_ITEMS_PER_TARGET = 200;

/**
 * The outbox format this build writes. Version 1 files may hold event kinds from before
 * `waiting` and `spend-cap`, which are upgraded as they are read.
 */
const OUTBOX_SCHEMA_VERSION = 2;

const OUTBOX_LIST_FIELD = "notifications";

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

function upgradeStoredItem(stored: unknown, fromVersion: number): unknown {
  if (fromVersion >= OUTBOX_SCHEMA_VERSION || !isRecord(stored)) {
    return stored;
  }
  const queuedAt = typeof stored["fireAt"] === "number" ? stored["fireAt"] : Date.now();
  return { ...stored, event: upgradeStoredNotifyEvent(stored["event"], queuedAt) };
}

/**
 * On-disk shape of one target's outbox, shared with the sender in adapters:
 * `{ schemaVersion, notifications: [...] }`. An item that cannot be read is dropped with a
 * warning and the rest of the queue is kept.
 */
export const OUTBOX_FILE_KIND: StateFileKind<OutboxItem[]> = {
  noun: "notifications",
  schemaVersion: OUTBOX_SCHEMA_VERSION,
  parse: (document, schemaVersion) => {
    const list =
      schemaVersion === undefined && Array.isArray(document)
        ? document
        : isRecord(document)
          ? document[OUTBOX_LIST_FIELD]
          : undefined;
    if (!Array.isArray(list)) {
      return { ok: false, error: "expected a list of notifications" };
    }
    const fromVersion = schemaVersion ?? 0;
    const items: OutboxItem[] = [];
    const dropped: string[] = [];
    for (const [index, stored] of (list as readonly unknown[]).entries()) {
      const parsed = OutboxItemSchema.safeParse(upgradeStoredItem(stored, fromVersion));
      if (parsed.success) {
        items.push(parsed.data);
      } else {
        dropped.push(`entry ${index}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
      }
    }
    if (dropped.length > 0) {
      process.stderr.write(
        `[jazz] Dropped ${dropped.length} unreadable queued notification(s): ${dropped.join("; ")}\n`,
      );
    }
    return { ok: true, content: items };
  },
  serialize: (items) => ({ [OUTBOX_LIST_FIELD]: items }),
};

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

/** The desktop target used while `notify.targets` is unset. */
const IMPLICIT_DESKTOP_TARGET: NotifyTarget = { name: "desktop", kind: "desktop" };

const DEFAULT_TARGETS: readonly NotifyTarget[] = [IMPLICIT_DESKTOP_TARGET];

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

/** Whether `target` is the desktop target Jazz uses while `notify.targets` is unset. */
export function isImplicitDesktopTarget(target: NotifyTarget): boolean {
  return target === IMPLICIT_DESKTOP_TARGET;
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
  /** Targets the event was queued on by this call. */
  readonly queued: readonly string[];
  /** Targets named in `options.targets` that are not configured. */
  readonly missing: readonly string[];
  /** True when every routed target already had the dedupe key, so nothing was queued. */
  readonly duplicate: boolean;
}

/**
 * Some routed targets could not take the event (a full outbox, an I/O error). The event is on
 * the `queued` targets, and its dedupe key is spent only there, so queueing it again with the
 * same key reaches the ones that failed.
 */
export class NotificationQueueError extends Error {
  constructor(
    readonly queued: readonly string[],
    readonly failures: readonly { readonly target: string; readonly error: Error }[],
  ) {
    super(failures.map((failure) => `"${failure.target}": ${failure.error.message}`).join("; "));
    this.name = "NotificationQueueError";
  }
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

/** The dedupe log entry recording that `key` went onto `target`'s queue. */
function targetDedupeKey(key: string, target: string): string {
  return `${key}\u0000${target}`;
}

/** Whether `key` was spent on `target`; a key recorded without a target covers every target. */
function wasSent(sent: DedupeLog, key: string, target: string): boolean {
  return sent[key] !== undefined || sent[targetDedupeKey(key, target)] !== undefined;
}

/** The log without keys past their retention. */
function prunedDedupeLog(sent: DedupeLog, now: number): Record<string, number> {
  const kept: Record<string, number> = {};
  for (const [existing, at] of Object.entries(sent)) {
    if (now - at < DEDUPE_RETENTION_MS) {
      kept[existing] = at;
    }
  }
  return kept;
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

interface AppendReport {
  readonly queued: readonly string[];
  readonly failures: readonly { readonly target: string; readonly error: Error }[];
}

function appendToEach(
  baseDirectory: string,
  targets: readonly string[],
  event: NotifyEvent,
  now: number,
): Effect.Effect<AppendReport> {
  return Effect.gen(function* () {
    const queued: string[] = [];
    const failures: { target: string; error: Error }[] = [];
    for (const target of targets) {
      const appended = yield* appendToTarget(baseDirectory, target, {
        id: newItemId(now),
        fireAt: now,
        event,
      }).pipe(Effect.either);
      if (appended._tag === "Right") {
        queued.push(target);
      } else {
        failures.push({ target, error: appended.left });
      }
    }
    return { queued, failures };
  });
}

/**
 * Append to every target that has not had `key` yet, and spend the key on each target the
 * event actually went onto. Runs under the dedupe log's lock, so two processes queueing the
 * same key never both queue it.
 */
function appendOncePerKey(
  home: string,
  baseDirectory: string,
  targets: readonly string[],
  event: NotifyEvent,
  key: string,
  now: number,
): Effect.Effect<AppendReport & { readonly duplicate: boolean }, Error> {
  const filePath = dedupePath(home);
  return withLock(
    `${filePath}.lock`,
    Effect.gen(function* () {
      const sent = (yield* readStateFile(filePath, DEDUPE_KIND, { onCorrupt: "quarantine" })) ?? {};
      const unsent = targets.filter((target) => !wasSent(sent, key, target));
      if (unsent.length === 0) {
        return { queued: [], failures: [], duplicate: true };
      }
      const report = yield* appendToEach(baseDirectory, unsent, event, now);
      if (report.queued.length > 0) {
        const next = prunedDedupeLog(sent, now);
        for (const target of report.queued) {
          next[targetDedupeKey(key, target)] = now;
        }
        yield* writeStateFile(filePath, DEDUPE_KIND, next);
      }
      return { ...report, duplicate: false };
    }),
  );
}

/**
 * Queue `event` on every target it routes to. Nothing is sent here; a drain sends it. With no
 * target to send to this is a no-op that touches no file. Fails with
 * {@link NotificationQueueError} when a routed target could not take it.
 */
export function enqueueNotification(
  targets: readonly NotifyTarget[],
  event: NotifyEvent,
  options: EnqueueOptions = {},
): Effect.Effect<EnqueueResult, Error> {
  return Effect.gen(function* () {
    const notificationService = yield* Effect.serviceOption(NotificationServiceTag);
    const desktopAvailable =
      notificationService._tag === "None" || notificationService.value.desktopAvailable();
    const routed = routeNotification(targets, event, options);
    const { missing } = routed;
    const skipped = new Set(
      desktopAvailable ? [] : targets.filter(isImplicitDesktopTarget).map((target) => target.name),
    );
    const chosen = routed.targets.filter((name) => !skipped.has(name));
    if (chosen.length === 0) {
      return { queued: [], missing, duplicate: false };
    }
    const home = options.home ?? getJazzHomeDirectory();
    const now = options.now ?? Date.now();
    const baseDirectory = outboxDirectory(home);
    const report =
      options.dedupeKey === undefined
        ? { ...(yield* appendToEach(baseDirectory, chosen, event, now)), duplicate: false }
        : yield* appendOncePerKey(home, baseDirectory, chosen, event, options.dedupeKey, now);
    if (report.failures.length > 0) {
      return yield* Effect.fail(new NotificationQueueError(report.queued, report.failures));
    }
    return { queued: report.queued, missing, duplicate: report.duplicate };
  });
}
