import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { createRunLog, nullRunLog } from "./run-log";

function readRecords(dataDir: string): Record<string, unknown>[] {
  const directory = join(dataDir, "logs", "runs");
  const file = readdirSync(directory)[0];
  expect(file).toBeDefined();
  return readFileSync(join(directory, file as string), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("createRunLog", () => {
  it("records a start line, each event and the outcome", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "runlog-"));
    const log = createRunLog(dataDir, "chat-1");
    log.event({ type: "tools_detected", toolNames: ["add_reminder"] });
    log.event({ type: "tool_execution_start", toolName: "add_reminder" });
    log.finish({ ok: false, error: "timed out", rounds: 7 });

    const records = readRecords(dataDir);
    expect(records.map((record) => record["type"])).toEqual([
      "run_start",
      "tools_detected",
      "tool_execution_start",
      "run_finish",
    ]);
    expect(records.at(-1)).toMatchObject({ ok: false, error: "timed out", rounds: 7 });
  });

  it("stamps every record with elapsed time so a slow round is visible", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "runlog-"));
    const log = createRunLog(dataDir, "chat-1", new Date(Date.now() - 5_000));
    log.event({ type: "tool_execution_start", toolName: "add_reminder" });
    const elapsed = readRecords(dataDir).map((record) => record["elapsedMs"] as number);
    expect(elapsed[0]).toBe(0);
    expect(elapsed[1]).toBeGreaterThanOrEqual(5_000);
  });

  it("drops the bulky fields that other lines already cover", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "runlog-"));
    const log = createRunLog(dataDir, "chat-1");
    log.event({
      type: "approval_required",
      toolName: "run_shell",
      message: "rm -rf build",
      previewDiff: "d".repeat(10_000),
    });
    const record = readRecords(dataDir)[1] as Record<string, unknown>;
    expect(record["message"]).toBe("rm -rf build");
    expect(record).not.toHaveProperty("previewDiff");
  });

  it("keeps a conversation's turns sorted and never collides", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "runlog-"));
    createRunLog(dataDir, "chat-1", new Date("2026-08-24T10:00:00Z")).finish({ ok: true });
    createRunLog(dataDir, "chat-1", new Date("2026-08-24T11:00:00Z")).finish({ ok: true });
    const files = readdirSync(join(dataDir, "logs", "runs")).sort();
    expect(files).toHaveLength(2);
    expect(files[0]).toContain("10-00-00");
    expect(files[1]).toContain("11-00-00");
    // Nothing a shell would need quoting for.
    for (const file of files) expect(file).not.toContain(":");
  });

  it("sanitises a conversation key that is not filename-safe", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "runlog-"));
    createRunLog(dataDir, "../../etc/passwd").finish({ ok: true });
    const files = readdirSync(join(dataDir, "logs", "runs"));
    expect(files).toHaveLength(1);
    expect(files[0]).toStartWith("______etc_passwd-");
  });

  it("never throws when the directory cannot be created", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "runlog-"));
    // A file where the log directory needs to be.
    const log = createRunLog(
      join(dataDir, "logs", "runs", "blocked", "..", "..", "..", "\0bad"),
      "chat-1",
    );
    expect(() => {
      log.event({ type: "tools_detected" });
      log.finish({ ok: true });
    }).not.toThrow();
  });
});

describe("nullRunLog", () => {
  it("accepts everything and writes nothing", () => {
    const log = nullRunLog();
    expect(() => {
      log.event({ type: "anything" });
      log.finish({ ok: true });
    }).not.toThrow();
    expect(log.path).toBe("");
  });
});

describe("createRunLog coalescing and retention", () => {
  it("collapses a run of deltas into one line with counts", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "runlog-"));
    const log = createRunLog(dataDir, "chat-1");
    for (const word of ["Let", " me", " check", " the", " time"]) {
      log.event({ type: "thinking_chunk", content: word });
    }
    log.event({ type: "tool_execution_start", toolName: "add_reminder" });
    log.finish({ ok: true });

    const records = readRecords(dataDir);
    expect(records.map((record) => record["type"])).toEqual([
      "run_start",
      "thinking_chunk",
      "tool_execution_start",
      "run_finish",
    ]);
    expect(records[1]).toMatchObject({ chunks: 5, characters: 21 });
    expect(records[1]).toHaveProperty("streamedMs");
  });

  it("keeps separate runs of deltas separate, in arrival order", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "runlog-"));
    const log = createRunLog(dataDir, "chat-1");
    log.event({ type: "thinking_chunk", content: "aa" });
    log.event({ type: "text_chunk", delta: "b" });
    log.event({ type: "thinking_chunk", content: "cc" });
    log.finish({ ok: true });
    const records = readRecords(dataDir);
    expect(records.map((record) => record["type"])).toEqual([
      "run_start",
      "thinking_chunk",
      "text_chunk",
      "thinking_chunk",
      "run_finish",
    ]);
    expect(records[2]).toMatchObject({ chunks: 1, characters: 1 });
  });

  it("a runaway generation costs one line, not thousands", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "runlog-"));
    const log = createRunLog(dataDir, "chat-1");
    for (let index = 0; index < 9_190; index += 1) {
      log.event({ type: "thinking_chunk", content: "tok" });
    }
    log.finish({ ok: false, error: "timed out" });
    const records = readRecords(dataDir);
    expect(records).toHaveLength(3);
    expect(records[1]).toMatchObject({ chunks: 9_190, characters: 27_570 });
  });

  it("prunes old runs so a long-lived deploy does not grow without bound", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "runlog-"));
    const base = Date.parse("2026-08-24T10:00:00Z");
    for (let index = 0; index < 210; index += 1) {
      createRunLog(dataDir, "chat-1", new Date(base + index * 60_000)).finish({ ok: true });
    }
    const files = readdirSync(join(dataDir, "logs", "runs"));
    expect(files.length).toBeLessThanOrEqual(201);
    // The newest survives, the oldest is gone.
    expect(files.some((name) => name.includes("T10-00-00"))).toBe(false);
    // 209 minutes after 10:00 is 13:29.
    expect(files.some((name) => name.includes("T13-29-00"))).toBe(true);
  });
});
