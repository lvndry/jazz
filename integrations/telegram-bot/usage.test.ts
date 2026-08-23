import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { dailyCostCapBlockReason, recordUsage, todayUsage } from "./usage";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

function temporaryJazzHome(): string {
  const directory = mkdtempSync(join(tmpdir(), "jazz-tg-usage-"));
  directories.push(directory);
  return directory;
}

describe("Telegram daily usage", () => {
  it("distinguishes an unavailable price from a zero-cost priced run", () => {
    const jazzHome = temporaryJazzHome();

    recordUsage(jazzHome, 0, 12, true);
    recordUsage(jazzHome, 0, 8, false);

    expect(todayUsage(jazzHome)).toEqual({
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
      join(jazzHome, "tg-usage.json"),
      JSON.stringify({ [today]: { costUSD: 0.25, tokens: 40, runs: 1 } }),
    );

    recordUsage(jazzHome, 0.1, 10, false);

    expect(todayUsage(jazzHome).unpricedRuns).toBe(1);
    expect(readFileSync(join(jazzHome, "tg-usage.json"), "utf8")).toContain('"unpricedRuns": 1');
  });

  it("fails closed after an unpriced run only when a cap is enabled", () => {
    const usage = { costUSD: 0, tokens: 20, runs: 1, unpricedRuns: 1 };

    expect(dailyCostCapBlockReason(usage, 1)).toBe("unpriced");
    expect(dailyCostCapBlockReason(usage, 0)).toBeUndefined();
  });
});
