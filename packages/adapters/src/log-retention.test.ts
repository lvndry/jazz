import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ONE_SHOT_LOGS_DIRECTORY_NAME } from "@jazz/core/utils/paths";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  LOG_PRUNE_INTERVAL_MS,
  ONE_SHOT_LOG_RETENTION_MS,
  ROTATED_LOG_GENERATIONS,
  logRetentionPolicy,
  pruneLogsDirectory,
  pruneLogsDirectoryIfDue,
  rotatedLogPath,
  type LogRetentionPolicy,
} from "./log-retention";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 27, 12, 0, 0);

let directory: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-log-retention-"));
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

function writeLog(name: string, bytes: number, ageMs: number): string {
  const filePath = path.join(directory, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "x".repeat(bytes));
  const modifiedAt = new Date(NOW - ageMs);
  fs.utimesSync(filePath, modifiedAt, modifiedAt);
  return filePath;
}

const policy: LogRetentionPolicy = {
  retentionMs: 14 * MILLISECONDS_PER_DAY,
  maxTotalBytes: 10_000,
  maxFileBytes: 1_000,
};

describe("pruneLogsDirectory", () => {
  test("deletes files not written to within the retention window", async () => {
    const stale = writeLog("old-workflow.log", 10, 15 * MILLISECONDS_PER_DAY);
    const fresh = writeLog("jazz.log", 10, MILLISECONDS_PER_DAY);
    const report = await pruneLogsDirectory(directory, policy, NOW);
    expect(report.deleted).toEqual([stale]);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  test("rotates an oversized file and keeps a bounded number of generations", async () => {
    const jazzLog = writeLog("jazz.log", 2_000, 0);
    for (let round = 0; round < ROTATED_LOG_GENERATIONS + 2; round++) {
      writeLog("jazz.log", 2_000, 0);
      await pruneLogsDirectory(directory, policy, NOW);
    }
    expect(fs.existsSync(jazzLog)).toBe(false);
    for (let generation = 1; generation <= ROTATED_LOG_GENERATIONS; generation++) {
      expect(fs.existsSync(rotatedLogPath(jazzLog, generation))).toBe(true);
    }
    expect(fs.existsSync(rotatedLogPath(jazzLog, ROTATED_LOG_GENERATIONS + 1))).toBe(false);
  });

  test("rotates the daemon's log in place so its open descriptor keeps writing to it", async () => {
    const daemonLog = writeLog("daemon.log", 2_000, 0);
    const descriptor = fs.openSync(daemonLog, "a");
    try {
      await pruneLogsDirectory(directory, policy, NOW);
      fs.writeSync(descriptor, "after rotation");
    } finally {
      fs.closeSync(descriptor);
    }
    expect(fs.readFileSync(daemonLog, "utf-8")).toBe("after rotation");
    expect(fs.statSync(rotatedLogPath(daemonLog, 1)).size).toBe(2_000);
  });

  test("deletes the oldest files once the directory is over its size cap", async () => {
    const oldest = writeLog("a.log", 900, 3_000);
    const middle = writeLog("b.log", 900, 2_000);
    const newest = writeLog("c.log", 900, 1_000);
    const report = await pruneLogsDirectory(directory, { ...policy, maxTotalBytes: 2_000 }, NOW);
    expect(report.deleted).toEqual([oldest]);
    expect(fs.existsSync(middle)).toBe(true);
    expect(fs.existsSync(newest)).toBe(true);
  });

  test("drops one-shot job logs a day after their last write, and leaves other folders", async () => {
    const fired = writeLog(
      path.join(ONE_SHOT_LOGS_DIRECTORY_NAME, "reminder-abc.log"),
      10,
      ONE_SHOT_LOG_RETENTION_MS + 1,
    );
    const recent = writeLog(path.join(ONE_SHOT_LOGS_DIRECTORY_NAME, "reminder-def.log"), 10, 0);
    const botRun = writeLog(path.join("runs", "chat.ndjson"), 10, 30 * MILLISECONDS_PER_DAY);
    await pruneLogsDirectory(directory, policy, NOW);
    expect(fs.existsSync(fired)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    expect(fs.existsSync(botRun)).toBe(true);
  });
});

describe("pruneLogsDirectoryIfDue", () => {
  test("sweeps at most once per interval, across calls", async () => {
    writeLog("stale.log", 10, 15 * MILLISECONDS_PER_DAY);
    expect(await pruneLogsDirectoryIfDue(directory, policy, NOW)).not.toBeNull();
    writeLog("stale-again.log", 10, 15 * MILLISECONDS_PER_DAY);
    expect(await pruneLogsDirectoryIfDue(directory, policy, NOW + 1_000)).toBeNull();
    expect(fs.existsSync(path.join(directory, "stale-again.log"))).toBe(true);
    const later = await pruneLogsDirectoryIfDue(directory, policy, NOW + LOG_PRUNE_INTERVAL_MS);
    expect(later?.deleted).toEqual([path.join(directory, "stale-again.log")]);
  });
});

describe("logRetentionPolicy", () => {
  test("reads days and megabytes from config, with defaults", () => {
    expect(logRetentionPolicy({ retentionDays: 2, maxTotalSizeMB: 1 })).toMatchObject({
      retentionMs: 2 * MILLISECONDS_PER_DAY,
      maxTotalBytes: 1024 * 1024,
    });
    expect(logRetentionPolicy().retentionMs).toBe(14 * MILLISECONDS_PER_DAY);
  });
});
