import { describe, expect, test } from "bun:test";
import { backoffDelay } from "./backoff";
import { createHealthState } from "./health";

describe("backoffDelay", () => {
  test("grows exponentially up to the cap, jittered below the bound", () => {
    const options = { baseMs: 1_000, maxMs: 60_000 };
    expect(backoffDelay(0, options, () => 1)).toBe(1_000);
    expect(backoffDelay(3, options, () => 1)).toBe(8_000);
    expect(backoffDelay(20, options, () => 1)).toBe(60_000);
    expect(backoffDelay(3, options, () => 0.5)).toBe(4_000);
  });
});

describe("createHealthState", () => {
  test("is healthy while contact is recent, unhealthy once stale or failed", () => {
    let clock = 0;
    const health = createHealthState(90_000, 30_000, () => clock);
    expect(health.status().healthy).toBe(true);
    clock = 31_000;
    expect(health.status().healthy).toBe(false);
    health.beat();
    clock = 100_000;
    expect(health.status().healthy).toBe(true);
    clock = 200_000;
    expect(health.status().healthy).toBe(false);
    health.beat();
    health.fail("token rejected");
    expect(health.status()).toEqual({ healthy: false, detail: "token rejected" });
  });
});
