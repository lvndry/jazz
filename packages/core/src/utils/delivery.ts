/**
 * At-least-once delivery for scheduled items: reminders, wake triggers, and job-batch fan-in.
 *
 * An item moves `pending → firing → delivered | failed`:
 * - **pending** (no `delivery` on the record): waiting for its time.
 * - **firing**: one process claimed it, under the store's lock, and is running its effect (a
 *   notification, an agent turn). The claim names the process, so a claim whose process died
 *   is taken again instead of lost, and a live claim is never taken twice.
 * - **delivered**: the effect succeeded. Only now is the item removed (or, for a batch,
 *   stamped `deliveredAt`); nothing is ever deleted before its effect ran.
 * - **failed**: the effect failed. The error text and attempt count are kept on the record.
 *   A retryable failure waits out an exponential backoff and becomes due again; after
 *   {@link MAX_DELIVERY_ATTEMPTS} attempts, or when retrying cannot help, it stays failed with
 *   `nextAttemptAt: null` so a person (or a notify channel) can still see and act on it.
 *
 * Usage: a store keeps an optional `delivery: DeliveryState` on each record, calls
 * {@link isClaimable} under its lock to pick what to fire, {@link claimDelivery} to stamp the
 * claim, and {@link settleDelivery} with the {@link DeliveryOutcome} once the effect finishes.
 */

import { z } from "zod";
import type { ProcessOwner } from "@/core/utils/process";

/** Attempts before a failing item stops retrying and stays failed for a person to see. */
export const MAX_DELIVERY_ATTEMPTS = 5;

/** Wait before the first retry; each later retry doubles it. */
export const DELIVERY_RETRY_INITIAL_MS = 60_000;

/** Longest wait between retries. */
export const DELIVERY_RETRY_MAX_MS = 60 * 60_000;

/**
 * How long a claim held by a process on another machine is trusted. Its liveness cannot be
 * checked from here, so after this long it is presumed dead and the item is taken again.
 */
export const REMOTE_CLAIM_TRUST_MS = 6 * 60 * 60_000;

export type DeliveryState =
  | {
      readonly status: "firing";
      /** Attempts started so far, this one included. */
      readonly attempts: number;
      readonly owner: ProcessOwner;
      readonly claimedAt: number;
      /** The previous attempt's error, when this is a retry. */
      readonly lastError?: string;
    }
  | {
      readonly status: "failed";
      readonly attempts: number;
      readonly lastError: string;
      readonly lastAttemptAt: number;
      /** When the item is due again, or null once it has stopped retrying. */
      readonly nextAttemptAt: number | null;
    };

const ProcessOwnerSchema: z.ZodType<ProcessOwner> = z.object({
  pid: z.number().int(),
  host: z.string(),
  startedAt: z.number().exactOptional(),
});

/** On-disk shape of a {@link DeliveryState}, checked with the record that carries it. */
export const DeliveryStateSchema: z.ZodType<DeliveryState> = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("firing"),
    attempts: z.number().int().positive(),
    owner: ProcessOwnerSchema,
    claimedAt: z.number().finite(),
    lastError: z.string().exactOptional(),
  }),
  z.object({
    status: z.literal("failed"),
    attempts: z.number().int().positive(),
    lastError: z.string(),
    lastAttemptAt: z.number().finite(),
    nextAttemptAt: z.number().finite().nullable(),
  }),
]);

export type DeliveryOutcome =
  | { readonly delivered: true }
  | { readonly delivered: false; readonly error: string; readonly retryable: boolean };

/** How a claim's owner looks from this process (see `runs-in-flight.ts` in adapters). */
export type ClaimOwnerStatus = "alive" | "gone" | "unverifiable";

/** Whether an item that has stopped retrying is only kept so a person can see it. */
export function hasStoppedRetrying(delivery: DeliveryState | undefined): boolean {
  return delivery?.status === "failed" && delivery.nextAttemptAt === null;
}

/**
 * Whether an item may be claimed now. `ownerStatus` judges a firing claim's process; it is
 * only called for firing items.
 */
export function isClaimable(
  delivery: DeliveryState | undefined,
  now: number,
  ownerStatus: (owner: ProcessOwner) => ClaimOwnerStatus,
): boolean {
  if (delivery === undefined) {
    return true;
  }
  if (delivery.status === "failed") {
    return delivery.nextAttemptAt !== null && delivery.nextAttemptAt <= now;
  }
  const status = ownerStatus(delivery.owner);
  if (status === "gone") {
    return true;
  }
  return status === "unverifiable" && now - delivery.claimedAt > REMOTE_CLAIM_TRUST_MS;
}

/** The firing state a claim stamps on an item. */
export function claimDelivery(
  previous: DeliveryState | undefined,
  owner: ProcessOwner,
  now: number,
): DeliveryState {
  const lastError = previous?.status === "failed" ? previous.lastError : previous?.lastError;
  return {
    status: "firing",
    attempts: (previous?.attempts ?? 0) + 1,
    owner,
    claimedAt: now,
    ...(lastError !== undefined ? { lastError } : {}),
  };
}

/** Wait before retrying after `attempts` failed attempts. */
export function deliveryRetryDelayMs(attempts: number): number {
  return Math.min(
    DELIVERY_RETRY_INITIAL_MS * 2 ** Math.max(0, attempts - 1),
    DELIVERY_RETRY_MAX_MS,
  );
}

/**
 * What an item becomes when its effect finishes: `undefined` means delivered (the store
 * removes it or stamps it delivered); otherwise the failed state to keep.
 */
export function settleDelivery(
  current: DeliveryState | undefined,
  outcome: DeliveryOutcome,
  now: number,
): DeliveryState | undefined {
  if (outcome.delivered) {
    return undefined;
  }
  const attempts = current?.attempts ?? 1;
  const retry = outcome.retryable && attempts < MAX_DELIVERY_ATTEMPTS;
  return {
    status: "failed",
    attempts,
    lastError: outcome.error,
    lastAttemptAt: now,
    nextAttemptAt: retry ? now + deliveryRetryDelayMs(attempts) : null,
  };
}

/** A delivery state as a tool or a person reads it. */
export interface DeliveryReport {
  readonly status: "pending" | "delivering" | "retrying" | "failed";
  readonly attempts?: number;
  readonly lastError?: string;
  /** ISO time of the next retry, while one is scheduled. */
  readonly nextAttemptAt?: string;
}

/** Summarize where an item's delivery stands, for list tools and commands. */
export function describeDelivery(delivery: DeliveryState | undefined): DeliveryReport {
  if (delivery === undefined) {
    return { status: "pending" };
  }
  if (delivery.status === "firing") {
    return {
      status: "delivering",
      attempts: delivery.attempts,
      ...(delivery.lastError !== undefined ? { lastError: delivery.lastError } : {}),
    };
  }
  return delivery.nextAttemptAt === null
    ? { status: "failed", attempts: delivery.attempts, lastError: delivery.lastError }
    : {
        status: "retrying",
        attempts: delivery.attempts,
        lastError: delivery.lastError,
        nextAttemptAt: new Date(delivery.nextAttemptAt).toISOString(),
      };
}
