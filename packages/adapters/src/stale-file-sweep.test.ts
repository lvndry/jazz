import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { nodeSweepFileSystem, sweepStaleFiles, type SweepFileSystem } from "./stale-file-sweep";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const MAX_AGE_MS = 30 * DAY_MS;

let base: string;
let root: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jazz-sweep-")));
  root = path.join(base, "root");
  fs.mkdirSync(root);
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function writeAged(target: string, ageMs: number): string {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "body");
  const modifiedAt = new Date(NOW - ageMs);
  fs.utimesSync(target, modifiedAt, modifiedAt);
  return target;
}

const sweep = (overrides: Partial<Parameters<typeof sweepStaleFiles>[0]> = {}) =>
  sweepStaleFiles({ root, now: NOW, maxAgeMs: MAX_AGE_MS, maxEntries: 1000, ...overrides });

describe("sweepStaleFiles", () => {
  test("keeps a file just under the age limit and deletes one just over", async () => {
    const under = writeAged(path.join(root, "under.txt"), MAX_AGE_MS - 1);
    const exact = writeAged(path.join(root, "exact.txt"), MAX_AGE_MS);
    const over = writeAged(path.join(root, "over.txt"), MAX_AGE_MS + 1);
    const result = await sweep();
    expect(fs.existsSync(under)).toBe(true);
    expect(fs.existsSync(exact)).toBe(true);
    expect(fs.existsSync(over)).toBe(false);
    expect(result.deletedFiles).toBe(1);
    expect(result.bytesFreed).toBe(4);
  });

  test("does not follow a symlink to a directory or file outside the root", async () => {
    const outside = path.join(base, "outside");
    const outsideFile = writeAged(path.join(outside, "old.txt"), 90 * DAY_MS);
    fs.symlinkSync(outside, path.join(root, "linked-dir"));
    fs.symlinkSync(outsideFile, path.join(root, "linked-file"));
    const result = await sweep();
    expect(fs.existsSync(outsideFile)).toBe(true);
    expect(fs.existsSync(path.join(root, "linked-dir"))).toBe(true);
    expect(result.deletedFiles).toBe(0);
  });

  test("removes an old symlink as a link and leaves its target", async () => {
    const outsideFile = writeAged(path.join(base, "outside.txt"), 90 * DAY_MS);
    const link = path.join(root, "old-link");
    fs.symlinkSync(outsideFile, link);
    const old = new Date(NOW - 90 * DAY_MS);
    fs.lutimesSync(link, old, old);
    const result = await sweep();
    expect(fs.existsSync(outsideFile)).toBe(true);
    expect(fs.lstatSync(link, { throwIfNoEntry: false })).toBeUndefined();
    expect(result.deletedSymlinks).toBe(1);
  });

  test("refuses a directory that resolves outside the root", async () => {
    const outside = path.join(base, "outside");
    const outsideFile = writeAged(path.join(outside, "old.txt"), 90 * DAY_MS);
    fs.mkdirSync(path.join(root, "inner"));
    const escaping: SweepFileSystem = {
      ...nodeSweepFileSystem,
      realpath: async (target) =>
        target === path.join(root, "inner") ? outside : nodeSweepFileSystem.realpath(target),
    };
    const result = await sweep({ fileSystem: escaping });
    expect(fs.existsSync(outsideFile)).toBe(true);
    expect(result.failures.map((failure) => failure.operation)).toContain("containment");
  });

  test("prunes directories it emptied, keeps non-empty ones and the root", async () => {
    writeAged(path.join(root, "gone", "nested", "old.txt"), 40 * DAY_MS);
    writeAged(path.join(root, "mixed", "old.txt"), 40 * DAY_MS);
    const kept = writeAged(path.join(root, "mixed", "new.txt"), DAY_MS);
    fs.mkdirSync(path.join(root, "never-touched"));
    const result = await sweep();
    expect(fs.existsSync(path.join(root, "gone"))).toBe(false);
    expect(fs.existsSync(kept)).toBe(true);
    expect(fs.existsSync(path.join(root, "never-touched"))).toBe(true);
    expect(fs.existsSync(root)).toBe(true);
    expect(result.prunedDirectories).toBe(2);
  });

  test("collects a per-path failure and keeps sweeping", async () => {
    const stuck = writeAged(path.join(root, "a-stuck.txt"), 40 * DAY_MS);
    const other = writeAged(path.join(root, "b-other.txt"), 40 * DAY_MS);
    const failing: SweepFileSystem = {
      ...nodeSweepFileSystem,
      unlink: async (target) => {
        if (target === stuck) {
          throw new Error("EPERM");
        }
        await nodeSweepFileSystem.unlink(target);
      },
    };
    const result = await sweep({ fileSystem: failing });
    expect(fs.existsSync(other)).toBe(false);
    expect(result.deletedFiles).toBe(1);
    expect(result.failures).toEqual([{ path: stuck, operation: "unlink", message: "EPERM" }]);
  });

  test("stops at the entry bound and reports truncation", async () => {
    for (let index = 0; index < 10; index += 1) {
      writeAged(path.join(root, `file-${String(index)}.txt`), 40 * DAY_MS);
    }
    const result = await sweep({ maxEntries: 4 });
    expect(result.examined).toBe(4);
    expect(result.truncated).toBe(true);
    expect(result.deletedFiles).toBe(4);
    expect(fs.readdirSync(root)).toHaveLength(6);
  });

  test("a missing root is not a failure and never throws", async () => {
    const result = await sweep({ root: path.join(base, "absent") });
    expect(result.failures).toEqual([]);
    expect(result.examined).toBe(0);
  });
});
