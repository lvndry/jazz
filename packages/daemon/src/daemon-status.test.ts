import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  clearDaemonStatus,
  DAEMON_STATUS_RECENT_ERRORS,
  daemonStatusPath,
  readDaemonStatus,
  withTickError,
  writeDaemonStatus,
  type DaemonStatusRecord,
} from "./daemon-status";

const PORT = 4999;
let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env["JAZZ_HOME"];
  home = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-daemon-status-"));
  process.env["JAZZ_HOME"] = home;
});

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env["JAZZ_HOME"];
  } else {
    process.env["JAZZ_HOME"] = previousHome;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

const RECORD: DaemonStatusRecord = {
  pid: 123,
  host: "127.0.0.1",
  port: PORT,
  startedAt: "2026-09-27T10:00:00.000Z",
  servesPeers: true,
  tickIntervalMs: 5_000,
  lastTickStartedAt: "2026-09-27T10:00:05.000Z",
  lastTickDurationMs: 8,
  tickRunning: false,
  runsInFlight: 2,
  recentErrors: [],
};

describe("the daemon status record", () => {
  it("round-trips, private to the owner, and is gone once cleared", async () => {
    await writeDaemonStatus(RECORD);
    expect(fs.statSync(daemonStatusPath(PORT)).mode & 0o777).toBe(0o600);
    expect(await readDaemonStatus(PORT)).toEqual(RECORD);
    await clearDaemonStatus(PORT);
    expect(await readDaemonStatus(PORT)).toBeUndefined();
  });

  it("reads a damaged record as absent", async () => {
    fs.mkdirSync(path.dirname(daemonStatusPath(PORT)), { recursive: true });
    fs.writeFileSync(daemonStatusPath(PORT), "{ not json");
    expect(await readDaemonStatus(PORT)).toBeUndefined();
  });

  it("keeps only the newest tick errors", () => {
    let errors = withTickError([], { at: "t0", work: "goal", message: "first" });
    for (let index = 1; index <= DAEMON_STATUS_RECENT_ERRORS; index++) {
      errors = withTickError(errors, { at: `t${String(index)}`, work: "goal", message: "later" });
    }
    expect(errors).toHaveLength(DAEMON_STATUS_RECENT_ERRORS);
    expect(errors[0]?.at).toBe("t1");
  });
});
