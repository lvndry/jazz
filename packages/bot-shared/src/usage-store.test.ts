import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSpend } from "@jazz/core/spend/ledger";
import { afterEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { dailyCostCapBlockReason, recordUsage, todayUsage } from "./usage-store";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

function temporaryJazzHome(): string {
  const directory = mkdtempSync(join(tmpdir(), "jazz-usage-store-"));
  directories.push(directory);
  return directory;
}

describe("bridge usage in the spend ledger", () => {
  it("distinguishes an unavailable price from a zero-cost priced run", async () => {
    const jazzHome = temporaryJazzHome();

    await recordUsage(jazzHome, "telegram", {
      agentId: "tg_1",
      costUSD: 0,
      tokens: 12,
      costKnown: true,
    });
    await recordUsage(jazzHome, "telegram", {
      agentId: "tg_1",
      costUSD: 0,
      tokens: 8,
      costKnown: false,
    });

    expect(await todayUsage(jazzHome, "telegram")).toEqual({
      costUSD: 0,
      tokens: 20,
      runs: 2,
      unpricedRuns: 1,
    });
  });

  it("counts each bridge's runs against its own cap, in the machine-wide ledger", async () => {
    const jazzHome = temporaryJazzHome();

    await recordUsage(jazzHome, "telegram", {
      agentId: "tg_1",
      costUSD: 2,
      tokens: 1,
      costKnown: true,
    });
    await recordUsage(jazzHome, "discord", {
      agentId: "dc_1",
      costUSD: 0.5,
      tokens: 1,
      costKnown: true,
    });

    expect((await todayUsage(jazzHome, "discord")).costUSD).toBe(0.5);
    const machine = await Effect.runPromise(readSpend(Date.now(), jazzHome));
    expect(machine.today.total.costUSD).toBe(2.5);
    expect(machine.today.bySource.bot?.runs).toBe(2);
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
