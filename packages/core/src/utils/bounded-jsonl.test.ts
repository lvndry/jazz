import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendBoundedJsonlLine, readJsonlNewestFirst, rotatedJsonlPath } from "./bounded-jsonl";

let directory: string;
let filePath: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-bounded-jsonl-"));
  filePath = path.join(directory, "nested", "log.jsonl");
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

function parseNumber(line: string): number | undefined {
  try {
    const parsed = JSON.parse(line) as { readonly value?: unknown };
    return typeof parsed.value === "number" ? parsed.value : undefined;
  } catch {
    return undefined;
  }
}

describe("appendBoundedJsonlLine", () => {
  test("rotates once the file would pass its cap, keeping one older generation", async () => {
    const maxBytes = 200;
    for (let value = 0; value < 50; value++) {
      await appendBoundedJsonlLine(filePath, JSON.stringify({ value }), { maxBytes });
    }
    expect(fs.statSync(filePath).size).toBeLessThanOrEqual(maxBytes);
    expect(fs.statSync(rotatedJsonlPath(filePath)).size).toBeLessThanOrEqual(maxBytes);
    expect(fs.readdirSync(path.dirname(filePath)).sort()).toEqual(["log.jsonl", "log.jsonl.1"]);
  });

  test("starts a fresh line after a write that was cut off", async () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{"value":1}\n{"val');
    await appendBoundedJsonlLine(filePath, JSON.stringify({ value: 2 }), { maxBytes: 1_000 });
    const entries = await readJsonlNewestFirst(filePath, { parse: parseNumber, maxBytes: 1_000 });
    expect(entries).toEqual([2, 1]);
  });
});

describe("readJsonlNewestFirst", () => {
  test("reads newest first across the rotated generation", async () => {
    for (let value = 0; value < 30; value++) {
      await appendBoundedJsonlLine(filePath, JSON.stringify({ value }), { maxBytes: 150 });
    }
    const entries = await readJsonlNewestFirst(filePath, { parse: parseNumber, maxBytes: 300 });
    expect(entries[0]).toBe(29);
    const expectedRun = entries.map((_entry, index) => 29 - index);
    expect(entries).toEqual(expectedRun);
  });

  test("stops at the limit without reading the rest of a large file", async () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const lines = Array.from({ length: 20_000 }, (_unused, value) => JSON.stringify({ value }));
    fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
    const entries = await readJsonlNewestFirst(filePath, {
      parse: parseNumber,
      limit: 3,
      maxBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(entries).toEqual([19_999, 19_998, 19_997]);
  });

  test("reads at most maxBytes and drops the line the budget cut through", async () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const lines = Array.from({ length: 100 }, (_unused, value) =>
      JSON.stringify({ value, padding: "x".repeat(50) }),
    );
    fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
    const entries = await readJsonlNewestFirst(filePath, { parse: parseNumber, maxBytes: 200 });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThan(4);
    expect(entries[0]).toBe(99);
  });

  test("keeps multi-byte characters intact across chunk boundaries", async () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const wide = "é".repeat(40_000);
    fs.writeFileSync(filePath, `${JSON.stringify({ value: 1, wide })}\n`);
    const entries = await readJsonlNewestFirst(filePath, {
      parse: (line) => (JSON.parse(line) as { wide: string }).wide,
      maxBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(entries).toEqual([wide]);
  });

  test("returns nothing for a missing file", async () => {
    expect(await readJsonlNewestFirst(filePath, { parse: parseNumber, maxBytes: 100 })).toEqual([]);
  });
});
