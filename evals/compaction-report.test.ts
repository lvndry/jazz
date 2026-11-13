/** Regression coverage for private report creation, replacement and unsafe destinations. */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { saveReport } from "./compaction-report";

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "jazz-compaction-report-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("creates a private JSON report and truncates an existing regular report", () => {
  const output = join(temporaryDirectory(), "report.json");
  saveReport(output, { summary: "a longer original report" });
  expect(statSync(output).mode & 0o777).toBe(0o600);
  writeFileSync(output, "previous report with trailing bytes", { mode: 0o644 });
  chmodSync(output, 0o644);
  saveReport(output, { summary: "short" });
  expect(readFileSync(output, "utf8")).toBe(JSON.stringify({ summary: "short" }, null, 2));
  expect(statSync(output).mode & 0o777).toBe(0o600);
});

test("rejects a symlink without changing its target contents or permissions", () => {
  const directory = temporaryDirectory();
  const target = join(directory, "unrelated.txt");
  const output = join(directory, "report.json");
  writeFileSync(target, "keep this", { mode: 0o644 });
  const originalMode = statSync(target).mode;
  symlinkSync(target, output);
  expect(() => saveReport(output, { summary: "replace" })).toThrow();
  expect(readFileSync(target, "utf8")).toBe("keep this");
  expect(statSync(target).mode).toBe(originalMode);
});

test("rejects directories and FIFOs before changing permissions or blocking", () => {
  const directory = temporaryDirectory();
  expect(() => saveReport(directory, {})).toThrow();
  const output = join(directory, "report.fifo");
  execFileSync("mkfifo", [output]);
  expect(() => saveReport(output, {})).toThrow();
  expect(statSync(output).isFIFO()).toBe(true);
  chmodSync(output, 0o644);
  const originalMode = statSync(output).mode;
  const reader = openSync(output, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    expect(() => saveReport(output, {})).toThrow("must be a regular file");
    expect(statSync(output).mode).toBe(originalMode);
  } finally {
    closeSync(reader);
  }
});
