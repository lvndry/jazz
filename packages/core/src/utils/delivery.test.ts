import { describe, expect, it } from "bun:test";
import {
  claimDelivery,
  DELIVERY_RETRY_INITIAL_MS,
  deliveryRetryDelayMs,
  isClaimable,
  MAX_DELIVERY_ATTEMPTS,
  REMOTE_CLAIM_TRUST_MS,
  settleDelivery,
} from "./delivery";

const owner = { pid: 1, host: "here" };
const failure = { delivered: false, error: "boom", retryable: true } as const;

describe("delivery state", () => {
  it("backs off between retries and stops after the last attempt", () => {
    let state = claimDelivery(undefined, owner, 0);
    for (let attempt = 1; attempt < MAX_DELIVERY_ATTEMPTS; attempt++) {
      const failed = settleDelivery(state, failure, 0);
      expect(failed).toMatchObject({
        status: "failed",
        attempts: attempt,
        nextAttemptAt: deliveryRetryDelayMs(attempt),
      });
      state = claimDelivery(failed, owner, 0);
    }
    expect(settleDelivery(state, failure, 0)).toMatchObject({
      attempts: MAX_DELIVERY_ATTEMPTS,
      nextAttemptAt: null,
    });
    expect(deliveryRetryDelayMs(2)).toBe(2 * DELIVERY_RETRY_INITIAL_MS);
  });

  it("does not retry what retrying cannot fix", () => {
    const state = claimDelivery(undefined, owner, 0);
    expect(settleDelivery(state, { ...failure, retryable: false }, 0)).toMatchObject({
      nextAttemptAt: null,
    });
  });

  it("delivered clears the state", () => {
    expect(
      settleDelivery(claimDelivery(undefined, owner, 0), { delivered: true }, 0),
    ).toBeUndefined();
  });

  it("takes a claim again only when its owner is gone, or unverifiable for too long", () => {
    const firing = claimDelivery(undefined, owner, 0);
    expect(isClaimable(firing, 1, () => "alive")).toBe(false);
    expect(isClaimable(firing, 1, () => "gone")).toBe(true);
    expect(isClaimable(firing, REMOTE_CLAIM_TRUST_MS, () => "unverifiable")).toBe(false);
    expect(isClaimable(firing, REMOTE_CLAIM_TRUST_MS + 1, () => "unverifiable")).toBe(true);
  });
});
