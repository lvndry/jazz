import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { dailyCostCapBlockReason, recordUsage, todayUsage } from "./usage-store";

const USAGE_FILE = "tg-usage.json";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

function temporaryJazzHome(): string {
  const directory = mkdtempSync(join(tmpdir(), "jazz-usage-store-"));
  directories.push(directory);
  return directory;
}

describe("daily usage store", () => {
  it("distinguishes an unavailable price from a zero-cost priced run", () => {
    const jazzHome = temporaryJazzHome();

    recordUsage(jazzHome, USAGE_FILE, 0, 12, true);
    recordUsage(jazzHome, USAGE_FILE, 0, 8, false);

    expect(todayUsage(jazzHome, USAGE_FILE)).toEqual({
      costUSD: 0,
      tokens: 20,
      runs: 2,
      unpricedRuns: 1,
    });
  });

  it("reads usage files written before unpriced tracking was added", () => {
    const jazzHome = temporaryJazzHome();
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(
      join(jazzHome, USAGE_FILE),
      JSON.stringify({ [today]: { costUSD: 0.25, tokens: 40, runs: 1 } }),
    );

    recordUsage(jazzHome, USAGE_FILE, 0.1, 10, false);

    expect(todayUsage(jazzHome, USAGE_FILE).unpricedRuns).toBe(1);
    expect(readFileSync(join(jazzHome, USAGE_FILE), "utf8")).toContain('"unpricedRuns": 1');
  });

  it("fails closed after an unpriced run only when a cap is enabled", () => {
    const usage = { costUSD: 0, tokens: 20, runs: 1, unpricedRuns: 1 };

    expect(dailyCostCapBlockReason(usage, 1)).toBe("unpriced");
    expect(dailyCostCapBlockReason(usage, 0)).toBeUndefined();
  });

  it("keeps the numeric threshold behavior for priced runs", () => {
    const usage = { costUSD: 0.5, tokens: 20, runs: 1 };

    expect(dailyCostCapBlockReason(usage, 0.5)).toBe("reached");
    expect(dailyCostCapBlockReason(usage, 0.51)).toBeUndefined();
  });
});
