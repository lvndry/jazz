import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DaemonStatusRecord } from "@jazz/adapters/daemon/daemon-status";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { formatDaemonAttention } from "./daemon-attention";
import {
  decideDaemonState,
  formatDaemonStatus,
  readLastLines,
  type DaemonStatusReport,
} from "./daemon-inspect";

const NOW = Date.UTC(2026, 8, 27, 12, 0, 0);

const RECORD: DaemonStatusRecord = {
  pid: 4242,
  host: "127.0.0.1",
  port: 4747,
  startedAt: new Date(NOW - 3_600_000).toISOString(),
  servesPeers: false,
  tickIntervalMs: 5_000,
  lastTickStartedAt: new Date(NOW - 3_000).toISOString(),
  lastTickDurationMs: 12,
  tickRunning: false,
  runsInFlight: 1,
  recentErrors: [
    { at: new Date(NOW - 60_000).toISOString(), work: "trigger", message: "provider down" },
  ],
};

function report(overrides: Partial<DaemonStatusReport> = {}): DaemonStatusReport {
  return {
    state: "running",
    host: "127.0.0.1",
    port: 4747,
    pid: 4242,
    supervisor: "none",
    record: RECORD,
    pending: { reminders: 2, wakeTriggers: 1, jobBatches: 0 },
    logPath: "/home/bob/.jazz/logs/daemon.log",
    ...overrides,
  };
}

describe("decideDaemonState", () => {
  it("is running only when this home's daemon answers", () => {
    const base = { thisHome: "home-a", record: RECORD, recordProcessAlive: true };
    expect(decideDaemonState({ ...base, owner: "home-a" })).toBe("running");
    expect(decideDaemonState({ ...base, owner: "home-b" })).toBe("port-taken");
  });

  it("tells a daemon that died without stopping from one that was stopped", () => {
    const base = { owner: undefined, thisHome: "home-a" };
    expect(decideDaemonState({ ...base, record: RECORD, recordProcessAlive: false })).toBe(
      "crashed",
    );
    expect(decideDaemonState({ ...base, record: undefined, recordProcessAlive: false })).toBe(
      "stopped",
    );
  });
});

describe("formatDaemonStatus", () => {
  it("shows the pid, supervision, last tick, work in flight, what waits, and errors", () => {
    const text = formatDaemonStatus(report(), NOW);
    expect(text).toContain("running on http://127.0.0.1:4747 (pid 4242)");
    expect(text).toContain("not supervised");
    expect(text).toContain("sudo jazz daemon install");
    expect(text).toContain("Last tick: 3s ago, took 12ms");
    expect(text).toContain("In flight: 1");
    expect(text).toContain("2 reminder(s), 1 wake trigger(s), 0 job batch(es)");
    expect(text).toContain("trigger: provider down");
    expect(text).toContain("/home/bob/.jazz/logs/daemon.log");
  });

  it("shows how long a tick has been running when it is still going", () => {
    const text = formatDaemonStatus(
      report({
        record: {
          ...RECORD,
          tickRunning: true,
          lastTickStartedAt: new Date(NOW - 30 * 60_000).toISOString(),
        },
      }),
      NOW,
    );
    expect(text).toContain("Tick:      running since 30m ago");
  });

  it("points a systemd service at the journal", () => {
    expect(formatDaemonStatus(report({ supervisor: "systemd" }), NOW)).toContain(
      "journalctl -u jazz-daemon",
    );
  });

  it("says how to start a daemon that is not running", () => {
    const { record: _record, ...withoutRecord } = report({ state: "stopped" });
    const text = formatDaemonStatus(withoutRecord, NOW);
    expect(text).toContain("not running");
    expect(text).toContain("`jazz daemon`");
  });
});

describe("readLastLines", () => {
  let directory: string;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-daemon-logs-"));
  });
  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("returns the last lines of a file larger than one read", async () => {
    const filePath = path.join(directory, "daemon.log");
    const lines = Array.from({ length: 20_000 }, (_unused, index) => `line ${String(index)}`);
    fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
    expect(await readLastLines(filePath, 3)).toEqual(["line 19997", "line 19998", "line 19999"]);
  });

  it("returns the whole file when it has fewer lines than asked", async () => {
    const filePath = path.join(directory, "daemon.log");
    fs.writeFileSync(filePath, "only\n");
    expect(await readLastLines(filePath, 50)).toEqual(["only"]);
  });
});

/** The merged status keeps main's pause/spend/approval details alongside daemon health. */
it("retains background pause, spend caps and waiting approvals in the status text", () => {
  const text = formatDaemonAttention({
    paused: null,
    pauseReason: "Paused by you",
    spendToday: { runs: 2, totalTokens: 120, costUSD: 0.5, costKnown: true },
    dailyCaps: { tokens: 1000, costUSD: 2 },
    caps: [],
    capLiftedToday: false,
    waiting: [],
  });
  expect(text).toContain("Paused by you");
  expect(text).toContain("$0.50 of $2.00");
  expect(text).toContain("Nothing is waiting for you.");
});
