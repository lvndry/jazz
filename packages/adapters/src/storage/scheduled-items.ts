/**
 * Claim and settle scheduled items (reminders, wake triggers) kept as one versioned JSON list
 * per agent, with at-least-once delivery (see `delivery.ts` in core).
 *
 * Every claim and every settle is one read-modify-write under the agent's lock, so "take it if
 * nobody else has" is atomic across the daemon's ticker, the host scheduler's one-shot fire
 * command, and a chat bridge's sweep: an item is fired only by the process whose claim landed.
 * A claim marks the item in this process's in-flight set before the lock is released, and the
 * caller clears it with {@link finishClaim} once the item is settled.
 *
 * Usage:
 * ```ts
 * const claims = yield* claimDueItems(store, baseDirectory, Date.now());
 * // run each claim's effect, then:
 * yield* settleItem(store, baseDirectory, claim.agentId, claim.item.id, outcome);
 * finishClaim(store, claim.agentId, claim.item.id);
 * ```
 */

import * as nodeFs from "node:fs/promises";
import {
  claimDelivery,
  type DeliveryOutcome,
  type DeliveryState,
  isClaimable,
  settleDelivery,
} from "@jazz/core/utils/delivery";
import { currentProcessOwner } from "@jazz/core/utils/process";
import {
  CorruptStateFileError,
  readStateFile,
  type StateFileKind,
  writeStateFile,
} from "@jazz/core/utils/state-file";
import { isValidStorageKey, withLock } from "@jazz/core/utils/storage";
import { Effect } from "effect";
import { claimOwnerStatus, clearInFlight, markInFlight } from "@/adapters/daemon/runs-in-flight";

export interface ScheduledItem {
  readonly id: string;
  /** Epoch ms the item is scheduled for. */
  readonly fireAt: number;
  readonly delivery?: DeliveryState;
}

/** Where one kind of scheduled item lives and how its file is read. */
export interface ScheduledItemStore<Item extends ScheduledItem> {
  /** "reminder", "wake trigger": names the claim in the in-flight set. */
  readonly noun: string;
  readonly kind: StateFileKind<Item[]>;
  readonly filePath: (baseDirectory: string, agentId: string) => string;
  readonly lockPath: (baseDirectory: string, agentId: string) => string;
}

export interface ScheduledItemClaim<Item extends ScheduledItem> {
  readonly agentId: string;
  readonly item: Item;
}

function claimKey<Item extends ScheduledItem>(
  store: ScheduledItemStore<Item>,
  agentId: string,
  itemId: string,
): string {
  return `${store.noun}:${agentId}:${itemId}`;
}

function claimableNow<Item extends ScheduledItem>(
  store: ScheduledItemStore<Item>,
  agentId: string,
  item: Item,
  now: number,
): boolean {
  return isClaimable(item.delivery, now, (owner) =>
    claimOwnerStatus(owner, claimKey(store, agentId, item.id)),
  );
}

/** Read an agent's items under its lock: a corrupt file is quarantined and reads as empty. */
export function readItemsLocked<Item extends ScheduledItem>(
  store: ScheduledItemStore<Item>,
  filePath: string,
): Effect.Effect<Item[], Error> {
  return readStateFile(filePath, store.kind, { onCorrupt: "quarantine" }).pipe(
    Effect.map((items) => items ?? []),
  );
}

/**
 * Take the claim on `items` that pass `select`, stamp them firing, and write the file once.
 * Runs under the agent's lock.
 */
function claimInFile<Item extends ScheduledItem>(
  store: ScheduledItemStore<Item>,
  baseDirectory: string,
  agentId: string,
  now: number,
  select: (item: Item) => boolean,
): Effect.Effect<Item[], Error> {
  const filePath = store.filePath(baseDirectory, agentId);
  return withLock(
    store.lockPath(baseDirectory, agentId),
    Effect.gen(function* () {
      const items = yield* readItemsLocked(store, filePath);
      const owner = currentProcessOwner();
      const claimed: Item[] = [];
      const next = items.map((item) => {
        if (!select(item) || !claimableNow(store, agentId, item, now)) {
          return item;
        }
        const claimedItem = { ...item, delivery: claimDelivery(item.delivery, owner, now) };
        claimed.push(claimedItem);
        return claimedItem;
      });
      if (claimed.length === 0) {
        return claimed;
      }
      yield* writeStateFile(filePath, store.kind, next);
      for (const item of claimed) {
        markInFlight(claimKey(store, agentId, item.id));
      }
      return claimed;
    }),
  );
}

/**
 * The unlocked look a sweep takes before locking an agent's file. A corrupt file counts as due,
 * so the locked pass quarantines it; a file from a newer Jazz is left alone.
 */
function hasClaimableItem<Item extends ScheduledItem>(
  store: ScheduledItemStore<Item>,
  baseDirectory: string,
  agentId: string,
  now: number,
): Effect.Effect<boolean> {
  return readStateFile(store.filePath(baseDirectory, agentId), store.kind, {
    onCorrupt: "fail",
  }).pipe(
    Effect.map((items) =>
      (items ?? []).some((item) => item.fireAt <= now && claimableNow(store, agentId, item, now)),
    ),
    Effect.catchAll((error) => Effect.succeed(error instanceof CorruptStateFileError)),
  );
}

/**
 * Claim every due item under `baseDirectory`, across agents. An agent whose lock cannot be
 * taken this sweep is retried on the next one, so one stuck agent never blocks the rest.
 * `includeAgent` leaves out agents another process delivers for (a chat bridge's own).
 */
export function claimDueItems<Item extends ScheduledItem>(
  store: ScheduledItemStore<Item>,
  baseDirectory: string,
  now: number,
  options: { readonly includeAgent?: (agentId: string) => boolean } = {},
): Effect.Effect<ReadonlyArray<ScheduledItemClaim<Item>>, Error> {
  return Effect.gen(function* () {
    const names = yield* Effect.tryPromise({
      try: () => nodeFs.readdir(baseDirectory),
      catch: (error) => error,
    }).pipe(Effect.catchAll(() => Effect.succeed<string[]>([])));
    const agentIds = names
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .filter((agentId) => isValidStorageKey(agentId))
      .filter((agentId) => options.includeAgent?.(agentId) ?? true);

    const claims: Array<ScheduledItemClaim<Item>> = [];
    for (const agentId of agentIds) {
      if (!(yield* hasClaimableItem(store, baseDirectory, agentId, now))) {
        continue;
      }
      const claimed = yield* claimInFile(
        store,
        baseDirectory,
        agentId,
        now,
        (item) => item.fireAt <= now,
      ).pipe(Effect.catchAll(() => Effect.succeed([] as Item[])));
      for (const item of claimed) {
        claims.push({ agentId, item });
      }
    }
    return claims;
  });
}

/**
 * Claim one item by id, whatever its time: the host scheduler fires it at the minute it was
 * set for, which may be seconds before `fireAt`. Undefined when the item is gone or another
 * process holds a live claim on it.
 */
export function claimItem<Item extends ScheduledItem>(
  store: ScheduledItemStore<Item>,
  baseDirectory: string,
  agentId: string,
  itemId: string,
  now: number,
): Effect.Effect<Item | undefined, Error> {
  return claimInFile(store, baseDirectory, agentId, now, (item) => item.id === itemId).pipe(
    Effect.map((claimed) => claimed[0]),
  );
}

/**
 * Record how a claimed item's effect ended: delivered items are removed, failed ones keep the
 * error and attempt count (and a retry time while attempts remain). An item removed in the
 * meantime (cancelled while firing) stays removed. Returns the item as settled, or undefined
 * when it was delivered or is gone.
 */
export function settleItem<Item extends ScheduledItem>(
  store: ScheduledItemStore<Item>,
  baseDirectory: string,
  agentId: string,
  itemId: string,
  outcome: DeliveryOutcome,
  now: number = Date.now(),
): Effect.Effect<Item | undefined, Error> {
  const filePath = store.filePath(baseDirectory, agentId);
  return withLock(
    store.lockPath(baseDirectory, agentId),
    Effect.gen(function* () {
      const items = yield* readItemsLocked(store, filePath);
      const current = items.find((item) => item.id === itemId);
      if (current === undefined) {
        return undefined;
      }
      const delivery = settleDelivery(current.delivery, outcome, now);
      if (delivery === undefined) {
        yield* writeStateFile(
          filePath,
          store.kind,
          items.filter((item) => item.id !== itemId),
        );
        return undefined;
      }
      const settled = { ...current, delivery };
      yield* writeStateFile(
        filePath,
        store.kind,
        items.map((item) => (item.id === itemId ? settled : item)),
      );
      return settled;
    }),
  );
}

/** Drop a claim from this process's in-flight set once it has been settled (or abandoned). */
export function finishClaim<Item extends ScheduledItem>(
  store: ScheduledItemStore<Item>,
  agentId: string,
  itemId: string,
): void {
  clearInFlight(claimKey(store, agentId, itemId));
}
