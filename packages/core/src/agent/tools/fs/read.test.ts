import { appendFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createReadFileTool, formatNumberedContent, resolveLineRange } from "./read";
import { runTool } from "./test-helpers";

describe("formatNumberedContent", () => {
  it("prefixes 1-based line numbers with a pipe", () => {
    expect(formatNumberedContent(["alpha", "beta"], 1)).toBe("1|alpha\n2|beta");
  });

  it("pads to the width of the last line number", () => {
    expect(formatNumberedContent(["a", "b"], 9)).toBe(" 9|a\n10|b");
  });

  it("returns empty string for no lines", () => {
    expect(formatNumberedContent([], 1)).toBe("");
  });
});

describe("resolveLineRange", () => {
  it("defaults to the whole file", () => {
    expect(resolveLineRange(undefined, undefined, 10)).toEqual({ startLine: 1, endLine: 10 });
  });

  it("clamps positive bounds", () => {
    expect(resolveLineRange(2, 99, 5)).toEqual({ startLine: 2, endLine: 5 });
  });

  it("treats negative startLine as counting from the end", () => {
    expect(resolveLineRange(-3, undefined, 10)).toEqual({ startLine: 8, endLine: 10 });
  });

  it("treats -1 as the last line", () => {
    expect(resolveLineRange(-1, -1, 10)).toEqual({ startLine: 10, endLine: 10 });
  });

  it("handles an empty file", () => {
    expect(resolveLineRange(1, 10, 0)).toEqual({ startLine: 1, endLine: 0 });
  });
});

describe("read_file tool", () => {
  const testDir = join(tmpdir(), `jazz-read-test-${Date.now()}`);
  const tool = createReadFileTool();

  beforeAll(() => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, "sample.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
    writeFileSync(join(testDir, "empty.txt"), "");
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns numbered content and keeps totalLines", async () => {
    const result = await runTool(tool, { path: join(testDir, "sample.ts") }, testDir);
    expect(result.success).toBe(true);
    const data = result.result as {
      content: string;
      totalLines: number;
      returnedLines: number;
      truncated: boolean;
    };
    expect(data.totalLines).toBe(4);
    expect(data.content).toContain("1|const a = 1;");
    expect(data.content).toContain("2|const b = 2;");
    expect(data.truncated).toBe(false);
  });

  it("reads the last N lines with a negative startLine", async () => {
    const result = await runTool(
      tool,
      { path: join(testDir, "sample.ts"), startLine: -2 },
      testDir,
    );
    expect(result.success).toBe(true);
    const data = result.result as {
      content: string;
      range: { startLine: number; endLine: number };
    };
    expect(data.range.startLine).toBe(3);
    expect(data.content).toContain("3|const c = 3;");
    expect(data.content).not.toContain("1|const a");
  });

  it("rejects startLine 0", async () => {
    const result = await runTool(tool, { path: join(testDir, "sample.ts"), startLine: 0 }, testDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain("0 is invalid");
  });

  it("reads an empty file without numbering", async () => {
    const result = await runTool(tool, { path: join(testDir, "empty.txt") }, testDir);
    expect(result.success).toBe(true);
    const data = result.result as { content: string; totalLines: number };
    expect(data.totalLines).toBe(0);
    expect(data.content).toBe("");
  });
});

/**
 * Following a file that is still being written used to mean re-reading it whole each time and
 * carrying a line number between looks in prose. `sinceByte` makes the offset the tool's business
 * instead — including telling the caller when the offset stopped meaning anything.
 */
describe("read_file with sinceByte", () => {
  const tool = createReadFileTool();
  const watchDir = join(tmpdir(), `jazz-read-since-${String(process.pid)}`);
  const logPath = join(watchDir, "app.log");

  beforeAll(() => {
    mkdirSync(watchDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(watchDir, { recursive: true, force: true });
  });

  function read(args: Record<string, unknown>) {
    return runTool(tool, { path: logPath, ...args }, watchDir);
  }

  it("returns only what was appended after the offset", async () => {
    writeFileSync(logPath, "first line\n");
    const initial = await read({ sinceByte: 0 });
    const data = initial.result as { content: string; nextByte: number; inode: number };
    expect(data.content).toContain("first line");

    appendFileSync(logPath, "second line\n");
    const next = await read({ sinceByte: data.nextByte, sinceInode: data.inode });
    const appended = next.result as { content: string; nextByte: number };

    expect(appended.content).toContain("second line");
    expect(appended.content).not.toContain("first line");
    expect(appended.nextByte).toBeGreaterThan(data.nextByte);
  });

  it("returns nothing and holds the offset when the file has not changed", async () => {
    writeFileSync(logPath, "steady\n");
    const first = await read({ sinceByte: 0 });
    const firstData = first.result as { nextByte: number; inode: number };

    const second = await read({ sinceByte: firstData.nextByte, sinceInode: firstData.inode });
    const secondData = second.result as { content: string; nextByte: number; reset?: string };

    expect(secondData.content).toBe("");
    expect(secondData.nextByte).toBe(firstData.nextByte);
    expect(secondData.reset).toBeUndefined();
  });

  /**
   * Truncation in place keeps the inode and drops the size below the offset. Left undetected the
   * caller reads past the end forever and sees an empty result that looks like a quiet file.
   */
  it("restarts from the top and says so when the file is truncated in place", async () => {
    writeFileSync(logPath, "a".repeat(500) + "\n");
    const before = await read({ sinceByte: 0 });
    const beforeData = before.result as { nextByte: number; inode: number };

    writeFileSync(logPath, "fresh start\n");
    const after = await read({ sinceByte: beforeData.nextByte, sinceInode: beforeData.inode });
    const afterData = after.result as { content: string; reset?: string };

    expect(afterData.reset).toBe("truncated");
    expect(afterData.content).toContain("fresh start");
  });

  /**
   * Rotation by rename gives the path a different file, and the replacement can be *longer* than
   * the stale offset — so only the inode reveals it. A size check alone reads unrelated content
   * from the middle of a new file and reports it as an append.
   */
  it("restarts from the top and says so when the file is rotated by rename", async () => {
    writeFileSync(logPath, "short\n");
    const before = await read({ sinceByte: 0 });
    const beforeData = before.result as { nextByte: number; inode: number };

    renameSync(logPath, join(watchDir, "app.log.1"));
    writeFileSync(logPath, "b".repeat(2000) + "\nrotated content\n");

    const after = await read({ sinceByte: beforeData.nextByte, sinceInode: beforeData.inode });
    const afterData = after.result as { content: string; reset?: string; inode: number };

    expect(afterData.reset).toBe("rotated");
    expect(afterData.content).toContain("rotated content");
    expect(afterData.inode).not.toBe(beforeData.inode);
  });

  it("refuses to mix byte offsets with line numbers", async () => {
    writeFileSync(logPath, "one\ntwo\n");
    const result = await read({ sinceByte: 0, startLine: 1 });

    expect(result.success).toBe(false);
    expect(result.error).toContain("one or the other");
  });
});
