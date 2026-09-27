import { describe, expect, it } from "bun:test";
import {
  capLifted,
  dailyCapReached,
  keepNotified,
  newlyWaiting,
  parseDaemonState,
  pauseInForce,
  startOfNextLocalDay,
  unattendedSpendToday,
  type WaitingItem,
} from "./attention";

const NOW = new Date(2026, 8, 27, 15, 0, 0);
const TODAY = new Date(2026, 8, 27, 9, 0, 0).toISOString();
const YESTERDAY = new Date(2026, 8, 26, 23, 30, 0).toISOString();

describe("unattendedSpendToday", () => {
  it("sums unattended runs started since local midnight, never a chat's", () => {
    expect(
      unattendedSpendToday(
        [
          { unattended: true, createdAt: TODAY, totalTokens: 1_000, costUSD: 0.5 },
          { unattended: true, createdAt: TODAY, totalTokens: 500, costUSD: 0.25 },
          { unattended: true, createdAt: YESTERDAY, totalTokens: 9_000, costUSD: 9 },
          { createdAt: TODAY, totalTokens: 9_000, costUSD: 9 },
        ],
        NOW,
      ),
    ).toEqual({ runs: 2, totalTokens: 1_500, costUSD: 0.75, costKnown: true });
  });

  it("stops knowing the cost once one counted run has no price", () => {
    const spend = unattendedSpendToday(
      [
        { unattended: true, createdAt: TODAY, totalTokens: 1_000, costUSD: 0.5 },
        { unattended: true, createdAt: TODAY, totalTokens: 1_000 },
      ],
      NOW,
    );
    expect(spend.costKnown).toBe(false);
    expect(spend.costUSD).toBeUndefined();
  });
});

describe("dailyCapReached", () => {
  const spend = { runs: 3, totalTokens: 10_000, costUSD: 2, costKnown: true };

  it("is reached at the dollar cap only while the cost is known", () => {
    expect(dailyCapReached({ dailyCostUSD: 2 }, spend)).toBe("cost");
    expect(dailyCapReached({ dailyCostUSD: 3 }, spend)).toBeUndefined();
    expect(
      dailyCapReached({ dailyCostUSD: 1 }, { runs: 3, totalTokens: 10_000, costKnown: false }),
    ).toBeUndefined();
  });

  it("is reached at the token cap, and never without a cap", () => {
    expect(dailyCapReached({ dailyTokens: 10_000 }, spend)).toBe("tokens");
    expect(dailyCapReached(undefined, spend)).toBeUndefined();
    expect(dailyCapReached({}, spend)).toBeUndefined();
  });
});

describe("the daemon's pause", () => {
  it("keeps a pause by the user until it is lifted", () => {
    const state = parseDaemonState({ paused: { kind: "user", at: TODAY }, notified: {} });
    expect(pauseInForce(state, NOW)?.kind).toBe("user");
  });

  it("lifts a daily-cap pause on its own when its day ends", () => {
    const until = startOfNextLocalDay(NOW).toISOString();
    const state = parseDaemonState({
      paused: { kind: "daily-cap", at: TODAY, limit: "cost", until },
      notified: {},
    });
    expect(pauseInForce(state, NOW)?.kind).toBe("daily-cap");
    expect(pauseInForce(state, new Date(Date.parse(until) + 1))).toBeUndefined();
  });

  it("knows when the user lifted today's cap", () => {
    const until = startOfNextLocalDay(NOW).toISOString();
    expect(capLifted(parseDaemonState({ capLiftedUntil: until, notified: {} }), NOW)).toBe(true);
    expect(capLifted(parseDaemonState({ capLiftedUntil: TODAY, notified: {} }), NOW)).toBe(false);
  });

  it("reads a damaged state file as empty rather than failing", () => {
    expect(parseDaemonState({ paused: { kind: "nope" } })).toEqual({ notified: {} });
    expect(parseDaemonState("garbage")).toEqual({ notified: {} });
  });
});

describe("announcing what waits", () => {
  const item = (key: string): WaitingItem => ({
    key,
    kind: "approval",
    title: "t",
    detail: "d",
    since: TODAY,
  });

  it("announces each item once and forgets items no longer waiting", () => {
    const notified = { "run:a:1": TODAY, "run:gone:1": TODAY };
    expect(newlyWaiting([item("run:a:1"), item("run:b:1")], notified).map((i) => i.key)).toEqual([
      "run:b:1",
    ]);
    expect(keepNotified(notified, [item("run:a:1")])).toEqual({ "run:a:1": TODAY });
  });
});
