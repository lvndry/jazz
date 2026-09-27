import { describe, expect, it } from "bun:test";
import {
  capLifted,
  keepNotified,
  newlyWaiting,
  parseDaemonState,
  pauseInForce,
  startOfNextLocalDay,
  type WaitingItem,
} from "./attention";

const NOW = new Date(2026, 8, 27, 15, 0, 0);
const TODAY = new Date(2026, 8, 27, 9, 0, 0).toISOString();

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
