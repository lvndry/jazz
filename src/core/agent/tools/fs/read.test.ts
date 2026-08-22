import { mkdirSync, writeFileSync, rmSync } from "node:fs";
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
