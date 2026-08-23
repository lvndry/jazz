import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { dailyCostCapBlockReason, recordUsage, todayUsage } from "./usage";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

function temporaryJazzHome(): string {
  const directory = mkdtempSync(join(tmpdir(), "jazz-dc-usage-"));
  directories.push(directory);
  return directory;
}

describe("Discord daily usage", () => {
  it("persists unpriced runs separately from known cost", () => {
    const jazzHome = temporaryJazzHome();

    recordUsage(jazzHome, 0.02, 12, true);
    recordUsage(jazzHome, 0, 8, false);

    expect(todayUsage(jazzHome)).toEqual({
      costUSD: 0.02,
      tokens: 20,
      runs: 2,
      unpricedRuns: 1,
    });
  });

  it("keeps the numeric threshold behavior for priced runs", () => {
    const usage = { costUSD: 0.5, tokens: 20, runs: 1 };

    expect(dailyCostCapBlockReason(usage, 0.5)).toBe("reached");
    expect(dailyCostCapBlockReason(usage, 0.51)).toBeUndefined();
  });
});
