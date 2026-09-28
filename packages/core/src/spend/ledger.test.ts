import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { checkAndReserveSpendCaps, evaluateSpendCaps } from "./caps";
import {
  checkAndReserveSpend,
  compactSpendLedger,
  IN_FLIGHT_MAX_AGE_MS,
  localDayKey,
  parseDayFile,
  readSpend,
  recordSpend,
  releaseInFlightSpend,
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
    unattended: true,
  });
}

describe("spend ledger", () => {
  it("adds up today's runs by agent and by source", async () => {
    const home = temporaryHome();
    await Effect.runPromise(
      recordSpend(
        {
          agentId: "a",
          source: "workflow",
          costUSD: 0.5,
          costKnown: true,
          tokens: 100,
          unattended: true,
        },
        home,
      ),
    );
    await Effect.runPromise(
      recordSpend(
        {
          agentId: "b",
          source: "goal",
          costUSD: 0.25,
          costKnown: false,
          tokens: 50,
          unattended: true,
        },
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
      recordSpend(
        { agentId: "a", source: "run", costUSD: 0.1, costKnown: true, tokens: 1, unattended: true },
        home,
      ),
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
    expect(summary.schemaVersion).toBe(2);
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
      recordSpend(
        { agentId: "b", source: "run", costUSD: 2, costKnown: true, tokens: 1, unattended: true },
        home,
      ),
    );
    const spend = await Effect.runPromise(readSpend(Date.now(), home));

    expect(spend.today.total.costUSD).toBe(3);
    expect(spend.unreadableLines).toBe(1);
    expect(parseDayFile(readFileSync(dayFile, "utf8")).entries).toHaveLength(2);
  });

  it("keeps a day file none of whose lines can be read instead of compacting it away", async () => {
    const home = temporaryHome();
    const yesterday = Date.now() - DAY_MS;
    const daysDirectory = path.join(spendDirectory(home), "days");
    const dayFile = path.join(daysDirectory, `${localDayKey(yesterday)}.jsonl`);
    mkdirSync(daysDirectory, { recursive: true });
    writeFileSync(dayFile, `{"at":"torn\n{"foreign":true}\n`);

    await Effect.runPromise(compactSpendLedger(Date.now(), home));
    const spend = await Effect.runPromise(readSpend(Date.now(), home));

    expect(readdirSync(daysDirectory)).toEqual([`${localDayKey(yesterday)}.jsonl`]);
    expect(spend.days[localDayKey(yesterday)]?.total.runs ?? 0).toBe(0);
    expect(spend.unreadableLines).toBe(2);
  });
});

/** Entries and a summary written before the ledger recorded `unattended`. */
describe("spend ledger written by an earlier version", () => {
  function legacyLine(at: number, source: string, costUSD: number): string {
    return JSON.stringify({
      at: new Date(at).toISOString(),
      agentId: "a",
      source,
      costUSD,
      costKnown: true,
      tokens: 10,
    });
  }

  const totals = (costUSD: number, runs: number) => ({
    costUSD,
    runs,
    tokens: runs * 10,
    unpricedRuns: 0,
  });

  function writeLegacyLedger(home: string, earlier: number): void {
    const spend = spendDirectory(home);
    const daysDirectory = path.join(spend, "days");
    mkdirSync(daysDirectory, { recursive: true });
    writeFileSync(
      path.join(spend, "summary.json"),
      JSON.stringify({
        schemaVersion: 1,
        days: {
          [localDayKey(earlier)]: {
            total: totals(5, 2),
            byAgent: { a: totals(5, 2) },
            bySource: { workflow: totals(3, 1), chat: totals(2, 1) },
            byOrigin: {},
          },
        },
      }),
    );
    writeFileSync(
      path.join(daysDirectory, `${localDayKey(Date.now())}.jsonl`),
      `${legacyLine(Date.now(), "workflow", 1)}\n${legacyLine(Date.now(), "chat", 4)}\n`,
    );
  }

  it("reads it whole, classifying runs by source, and quarantines nothing", async () => {
    const home = temporaryHome();
    const earlier = Date.now() - DAY_MS;
    writeLegacyLedger(home, earlier);

    const spend = await Effect.runPromise(readSpend(Date.now(), home));

    expect(spend.unreadableLines).toBe(0);
    expect(spend.today.total.costUSD).toBe(5);
    expect(spend.today.unattended.costUSD).toBe(1);
    expect(spend.days[localDayKey(earlier)]?.total.costUSD).toBe(5);
    expect(spend.days[localDayKey(earlier)]?.unattended.costUSD).toBe(3);
    expect(readdirSync(spendDirectory(home)).some((name) => name.includes("corrupt"))).toBe(false);
  });

  it("keeps the totals through compaction and a rewrite at the current version", async () => {
    const home = temporaryHome();
    const earlier = Date.now() - DAY_MS;
    writeLegacyLedger(home, earlier);
    const yesterdayFile = path.join(
      spendDirectory(home),
      "days",
      `${localDayKey(earlier - DAY_MS)}.jsonl`,
    );
    writeFileSync(yesterdayFile, `${legacyLine(earlier - DAY_MS, "goal", 2)}\n`);

    await Effect.runPromise(compactSpendLedger(Date.now(), home));
    const spend = await Effect.runPromise(readSpend(Date.now(), home));
    const summary = JSON.parse(
      readFileSync(path.join(spendDirectory(home), "summary.json"), "utf8"),
    );

    expect(summary.schemaVersion).toBe(2);
    expect(spend.days[localDayKey(earlier)]?.unattended.costUSD).toBe(3);
    expect(spend.days[localDayKey(earlier - DAY_MS)]?.unattended.costUSD).toBe(2);
    expect(readdirSync(spendDirectory(home)).some((name) => name.includes("corrupt"))).toBe(false);
  });

  it("still binds the caps on what it recorded", async () => {
    const home = temporaryHome();
    writeLegacyLedger(home, Date.now() - DAY_MS);

    const spend = await Effect.runPromise(readSpend(Date.now(), home));

    expect(
      evaluateSpendCaps({ dailyCostUSD: 1 }, spend, { agentId: "a", source: "workflow" }),
    ).toMatchObject({ kind: "reached", spent: 1 });
  });
});

describe("in-flight reservations", () => {
  const workflow = { agentId: "a", source: "workflow" } as const;

  function spendOne(home: string, costUSD: number) {
    return Effect.runPromise(
      recordSpend(
        { agentId: "a", source: "workflow", costUSD, costKnown: true, tokens: 1, unattended: true },
        home,
      ),
    );
  }

  it("lets only one of two runs checked at once take the last headroom", async () => {
    const home = temporaryHome();
    await spendOne(home, 0.4);
    await spendOne(home, 0.4);

    const checks = await Promise.all(
      ["run-1", "run-2"].map((id) =>
        Effect.runPromise(checkAndReserveSpendCaps({ dailyCostUSD: 1 }, workflow, id, { home })),
      ),
    );

    expect(checks.map((check) => check.kind).sort()).toEqual(["clear", "reached"]);
  });

  it("frees the headroom when a reservation is released", async () => {
    const home = temporaryHome();
    await spendOne(home, 0.4);
    await spendOne(home, 0.4);
    const caps = { dailyCostUSD: 1 };

    expect(
      (await Effect.runPromise(checkAndReserveSpendCaps(caps, workflow, "run-1", { home }))).kind,
    ).toBe("clear");
    expect(
      (await Effect.runPromise(checkAndReserveSpendCaps(caps, workflow, "run-2", { home }))).kind,
    ).toBe("reached");
    await Effect.runPromise(releaseInFlightSpend("run-1", home));
    expect(
      (await Effect.runPromise(checkAndReserveSpendCaps(caps, workflow, "run-3", { home }))).kind,
    ).toBe("clear");
  });

  it("ignores and removes a reservation whose process is gone or that is too old", async () => {
    const home = temporaryHome();
    const directory = path.join(spendDirectory(home), "in-flight");
    mkdirSync(directory, { recursive: true });
    const reservation = (id: string, pid: number, startedAt: number) =>
      writeFileSync(
        path.join(directory, `${id}.json`),
        JSON.stringify({
          id,
          pid,
          startedAt: new Date(startedAt).toISOString(),
          agentId: "a",
          source: "workflow",
          costUSD: 5,
          tokens: 1,
        }),
      );
    const deadPid = 2 ** 22 + 1;
    reservation("dead", deadPid, Date.now());
    reservation("old", process.pid, Date.now() - IN_FLIGHT_MAX_AGE_MS - 1);
    reservation("live", process.pid, Date.now());

    const counted = await Effect.runPromise(
      checkAndReserveSpend((spend) => ({ outcome: spend.today.unattended.costUSD }), { home }),
    );

    expect(counted).toBe(5);
    expect(readdirSync(directory)).toEqual(["live.json"]);
  });
});
