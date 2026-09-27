/**
 * @fileoverview Draining the notify outbox: claim what is due on each channel, send it, and
 * settle each item as delivered (removed) or failed (kept with its error and next retry).
 *
 * The daemon drains every tick; a CLI command that may have queued something (`jazz run`, a
 * scheduled workflow, a reminder firing) drains before it exits, so delivery does not wait for
 * a daemon that may not be running. Claims follow the shared at-least-once rules
 * (`scheduled-items.ts`), so two processes draining at once never send an item twice while its
 * claimant is alive.
 */

import * as nodeFs from "node:fs/promises";
import { AgentConfigServiceTag } from "@jazz/core/interfaces/agent-config";
import {
  OUTBOX_FILE_KIND,
  type OutboxItem,
  outboxDirectory,
  outboxFilePath,
  outboxLockPath,
} from "@jazz/core/notify/outbox";
import type { NotifyChannelConfig } from "@jazz/core/types/notify";
import {
  type DeliveryOutcome,
  describeDelivery,
  hasStoppedRetrying,
} from "@jazz/core/utils/delivery";
import { writeStateFile } from "@jazz/core/utils/state-file";
import { withLock } from "@jazz/core/utils/storage";
import { Effect } from "effect";
import {
  claimDueItems,
  finishClaim,
  readItemsLocked,
  type ScheduledItemStore,
  settleItem,
} from "@/adapters/storage/scheduled-items";
import { type SendContext, sendToChannel } from "./channels";

/** Where notify outbox items live, for the shared claim and settle logic. */
export const NOTIFY_OUTBOX_STORE: ScheduledItemStore<OutboxItem> = {
  noun: "notification",
  kind: OUTBOX_FILE_KIND,
  filePath: outboxFilePath,
  lockPath: outboxLockPath,
};

export interface DrainReport {
  readonly delivered: number;
  readonly failed: number;
}

export interface DrainOptions {
  readonly home?: string;
  readonly now?: number;
  readonly send?: (
    channelName: string,
    channel: NotifyChannelConfig,
    item: OutboxItem,
    context: SendContext,
  ) => Effect.Effect<DeliveryOutcome, never>;
}

/**
 * Send everything due in the outbox, channel by channel, in queue order. Never fails: a
 * channel whose file cannot be claimed this pass is tried again on the next.
 */
export function drainNotifyOutbox(options: DrainOptions = {}) {
  return Effect.gen(function* () {
    const config = yield* AgentConfigServiceTag;
    const appConfig = yield* config.appConfig;
    const channels = appConfig.notifications?.channels ?? {};
    const baseDirectory = outboxDirectory(options.home);
    const now = options.now ?? Date.now();
    const claims = yield* claimDueItems(NOTIFY_OUTBOX_STORE, baseDirectory, now).pipe(
      Effect.catchAll(() => Effect.succeed([])),
    );
    const send =
      options.send ??
      ((channelName, channel, item, context) =>
        sendToChannel(channelName, channel, item.event, context));
    let delivered = 0;
    let failed = 0;
    const ordered = [...claims].sort((left, right) => left.item.fireAt - right.item.fireAt);
    for (const { agentId: channelName, item } of ordered) {
      const channel = channels[channelName];
      const outcome: DeliveryOutcome =
        channel === undefined
          ? {
              delivered: false,
              error: `No notify channel named "${channelName}" is configured any more.`,
              retryable: false,
            }
          : yield* send(channelName, channel, item, { deliveryId: item.id });
      if (outcome.delivered) {
        delivered += 1;
      } else {
        failed += 1;
      }
      yield* settleItem(
        NOTIFY_OUTBOX_STORE,
        baseDirectory,
        channelName,
        item.id,
        outcome,
        options.now ?? Date.now(),
      ).pipe(
        Effect.catchAll((error) =>
          Effect.sync(() =>
            process.stderr.write(
              `[jazz] Could not record a notification's delivery on "${channelName}": ${error.message}\n`,
            ),
          ),
        ),
        Effect.ensuring(Effect.sync(() => finishClaim(NOTIFY_OUTBOX_STORE, channelName, item.id))),
      );
    }
    return { delivered, failed } satisfies DrainReport;
  });
}

/** One queued notification as `jazz notify outbox` shows it. */
export interface OutboxEntry {
  readonly channel: string;
  readonly id: string;
  readonly kind: OutboxItem["event"]["kind"];
  readonly queuedAt: string;
  readonly delivery: ReturnType<typeof describeDelivery>;
}

async function channelNames(baseDirectory: string): Promise<string[]> {
  try {
    const names = await nodeFs.readdir(baseDirectory);
    return names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/** Everything still in the outbox, oldest first. */
export function listOutbox(home?: string): Effect.Effect<readonly OutboxEntry[], Error> {
  return Effect.gen(function* () {
    const baseDirectory = outboxDirectory(home);
    const names = yield* Effect.tryPromise({
      try: () => channelNames(baseDirectory),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });
    const entries: OutboxEntry[] = [];
    for (const channel of names) {
      const items = yield* withLock(
        outboxLockPath(baseDirectory, channel),
        readItemsLocked(NOTIFY_OUTBOX_STORE, outboxFilePath(baseDirectory, channel)),
      );
      for (const item of items) {
        entries.push({
          channel,
          id: item.id,
          kind: item.event.kind,
          queuedAt: new Date(item.fireAt).toISOString(),
          delivery: describeDelivery(item.delivery),
        });
      }
    }
    return entries.sort((left, right) => left.queuedAt.localeCompare(right.queuedAt));
  });
}

/**
 * Make every item that stopped retrying due again, so the next drain tries it afresh. Returns
 * how many were re-armed.
 */
export function retryStoppedNotifications(home?: string): Effect.Effect<number, Error> {
  return Effect.gen(function* () {
    const baseDirectory = outboxDirectory(home);
    const names = yield* Effect.tryPromise({
      try: () => channelNames(baseDirectory),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });
    let rearmed = 0;
    for (const channel of names) {
      const filePath = outboxFilePath(baseDirectory, channel);
      rearmed += yield* withLock(
        outboxLockPath(baseDirectory, channel),
        Effect.gen(function* () {
          const items = yield* readItemsLocked(NOTIFY_OUTBOX_STORE, filePath);
          let changed = 0;
          const next = items.map((item) => {
            if (hasStoppedRetrying(item.delivery)) {
              changed += 1;
              return { id: item.id, fireAt: item.fireAt, event: item.event };
            }
            return item;
          });
          if (changed > 0) {
            yield* writeStateFile(filePath, OUTBOX_FILE_KIND, next);
          }
          return changed;
        }),
      );
    }
    return rearmed;
  });
}
