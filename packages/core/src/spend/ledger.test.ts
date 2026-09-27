import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import {
  compactSpendLedger,
  localDayKey,
  parseDayFile,
  readSpend,
  recordSpend,
  spendDirectory,
} from "./ledger";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

function temporaryHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "jazz-spend-ledger-"));
  homes.push(home);
  return home;
}

const DAY_MS = 86_400_000;

function entryLine(at: number, agentId: string, costUSD: number): string {
  return JSON.stringify({
    at: new Date(at).toISOString(),
    agentId,
    source: "workflow",
    costUSD,
    costKnown: true,
    tokens: 10,
  });
}

describe("spend ledger", () => {
  it("adds up today's runs by agent and by source", async () => {
    const home = temporaryHome();
    await Effect.runPromise(
      recordSpend(
        { agentId: "a", source: "workflow", costUSD: 0.5, costKnown: true, tokens: 100 },
        home,
      ),
    );
    await Effect.runPromise(
      recordSpend(
        { agentId: "b", source: "goal", costUSD: 0.25, costKnown: false, tokens: 50 },
        home,
      ),
    );

    const spend = await Effect.runPromise(readSpend(Date.now(), home));

    expect(spend.today.total).toEqual({ costUSD: 0.75, runs: 2, tokens: 150, unpricedRuns: 1 });
    expect(spend.today.byAgent["a"]?.costUSD).toBe(0.5);
    expect(spend.today.bySource.goal?.unpricedRuns).toBe(1);
    expect(spend.month.total.costUSD).toBe(0.75);
  });

  it("keeps the day file private to its owner", async () => {
    const home = temporaryHome();
    await Effect.runPromise(
      recordSpend({ agentId: "a", source: "run", costUSD: 0.1, costKnown: true, tokens: 1 }, home),
    );
    const dayFile = path.join(spendDirectory(home), "days", `${localDayKey(Date.now())}.jsonl`);

    expect(statSync(dayFile).mode & 0o777).toBe(0o600);
  });

  it("compacts an earlier day into the summary and removes its file, counting it once", async () => {
    const home = temporaryHome();
    const yesterday = Date.now() - DAY_MS;
    const daysDirectory = path.join(spendDirectory(home), "days");
    mkdirSync(daysDirectory, { recursive: true });
    writeFileSync(
      path.join(daysDirectory, `${localDayKey(yesterday)}.jsonl`),
      `${entryLine(yesterday, "a", 1)}\n${entryLine(yesterday, "a", 2)}\n`,
    );

    await Effect.runPromise(compactSpendLedger(Date.now(), home));
    await Effect.runPromise(compactSpendLedger(Date.now(), home));
    const spend = await Effect.runPromise(readSpend(Date.now(), home));

    expect(readdirSync(daysDirectory)).toEqual([]);
    expect(spend.days[localDayKey(yesterday)]?.total.costUSD).toBe(3);
    expect(spend.days[localDayKey(yesterday)]?.total.runs).toBe(2);
    const summary = JSON.parse(
      readFileSync(path.join(spendDirectory(home), "summary.json"), "utf8"),
    );
    expect(summary.schemaVersion).toBe(1);
  });

  it("does not fold a day in twice when a crash left its file after the summary was written", async () => {
    const home = temporaryHome();
    const yesterday = Date.now() - DAY_MS;
    const daysDirectory = path.join(spendDirectory(home), "days");
    const dayFile = path.join(daysDirectory, `${localDayKey(yesterday)}.jsonl`);
    mkdirSync(daysDirectory, { recursive: true });
    writeFileSync(dayFile, `${entryLine(yesterday, "a", 1)}\n`);
    await Effect.runPromise(compactSpendLedger(Date.now(), home));
    writeFileSync(dayFile, `${entryLine(yesterday, "a", 1)}\n`);

    const spend = await Effect.runPromise(readSpend(Date.now(), home));
    await Effect.runPromise(compactSpendLedger(Date.now(), home));

    expect(spend.days[localDayKey(yesterday)]?.total.costUSD).toBe(1);
    expect(readdirSync(daysDirectory)).toEqual([]);
  });

  it("skips a torn line and starts the next entry on a line of its own", async () => {
    const home = temporaryHome();
    const daysDirectory = path.join(spendDirectory(home), "days");
    mkdirSync(daysDirectory, { recursive: true });
    const dayFile = path.join(daysDirectory, `${localDayKey(Date.now())}.jsonl`);
    writeFileSync(dayFile, `${entryLine(Date.now(), "a", 1)}\n{"at":"torn`);

    await Effect.runPromise(
      recordSpend({ agentId: "b", source: "run", costUSD: 2, costKnown: true, tokens: 1 }, home),
    );
    const spend = await Effect.runPromise(readSpend(Date.now(), home));

    expect(spend.today.total.costUSD).toBe(3);
    expect(spend.unreadableLines).toBe(1);
    expect(parseDayFile(readFileSync(dayFile, "utf8")).entries).toHaveLength(2);
  });
});
