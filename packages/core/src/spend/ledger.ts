/**
 * @fileoverview The machine-wide spend ledger: what every run on this Jazz home cost.
 *
 * One append-only file per local calendar day under `$JAZZ_HOME/spend/days/<YYYY-MM-DD>.jsonl`,
 * one JSON line per finished run (completed, failed, parked or cancelled), each append
 * fsynced under the ledger's lock. Days before today are compacted into
 * `$JAZZ_HOME/spend/summary.json`, which keeps per-day totals by agent, source and origin, and
 * the day file is removed once its totals are durably in the summary. A crash between the
 * two steps is harmless: a day already in the summary is never folded in twice.
 *
 * Every file is private to the owner (see `private-mode.ts`). Nothing here fails a run: the
 * caller decides what to do with a write error, and a torn or foreign line in a day file is
 * skipped on read rather than making the whole ledger unreadable. A day file none of whose lines
 * can be read is left in place rather than compacted, so nothing is thrown away unread.
 *
 * A run that passed the cap check and has not finished holds an in-flight reservation, one file
 * per run under `$JAZZ_HOME/spend/in-flight/`, which {@link checkAndReserveSpend} counts at its
 * estimated cost. It is removed when the run ends, and ignored once its process is gone or it is
 * older than {@link IN_FLIGHT_MAX_AGE_MS}, so a crash never holds spend back for long.
 *
 * Usage:
 * ```ts
 * yield* recordSpend({ agentId, source: "workflow", costUSD: 0.02, costKnown: true, tokens: 900, unattended: true });
 * const spend = yield* readSpend(Date.now());
 * spend.today.total.costUSD; // dollars spent today, across every run
 * ```
 */

import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import { Effect } from "effect";
import { z } from "zod";
import { toError } from "@/core/utils/errors";
import { getJazzHomeDirectory } from "@/core/utils/paths";
import { stateDirectoryMode, stateFileMode } from "@/core/utils/private-mode";
import { isProcessAlive } from "@/core/utils/process";
import { readStateFile, type StateFileKind, writeStateFile } from "@/core/utils/state-file";
import { isValidStorageKey, withLock, writeFileStringAtomic } from "@/core/utils/storage";
import { SPEND_SOURCES, type SpendSource } from "./sources";

/** Days of compacted totals kept: a full year plus the month in progress. */
export const RETAINED_SUMMARY_DAYS = 400;

/** Version 2 adds `unattended` and `unattendedByAgent` to every day. */
const SUMMARY_SCHEMA_VERSION = 2;

/**
 * An in-flight reservation older than this is ignored even when its pid is alive: pids are
 * reused, and no single run is expected to last a day.
 */
export const IN_FLIGHT_MAX_AGE_MS = 86_400_000;

const DAY_MS = 86_400_000;

const DAY_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** One finished run, as the ledger stores it. */
export interface SpendEntry {
  /** ISO time the run ended. */
  readonly at: string;
  readonly agentId: string;
  readonly source: SpendSource;
  /** Dollars spent; 0 when the price is unknown (see `costKnown`). */
  readonly costUSD: number;
  /** False when some of the run's tokens had no pricing, so `costUSD` understates it. */
  readonly costKnown: boolean;
  readonly tokens: number;
  /** Nobody could be asked while it ran, so it counts toward the `daemon` spend caps. */
  readonly unattended: boolean;
  readonly runId?: string;
  /** The surface the run came through when that is narrower than `source` ("telegram"). */
  readonly origin?: string;
}

/**
 * Sources whose runs have a person present to decide: a chat, a chat bot, and a run answering a
 * parked one. An entry stored without `unattended` is classified by this set.
 */
const ATTENDED_SOURCES: ReadonlySet<SpendSource> = new Set(["chat", "bot", "resume"]);

/** Whether a run from `source` counts as unattended when its entry does not say. */
export function isUnattendedBySource(source: SpendSource): boolean {
  return !ATTENDED_SOURCES.has(source);
}

/** What {@link recordSpend} takes; `at` defaults to now. */
export type SpendEntryInput = Omit<SpendEntry, "at"> & { readonly at?: string };

const SpendEntrySchema = z.object({
  at: z.string(),
  agentId: z.string(),
  source: z.enum(SPEND_SOURCES),
  costUSD: z.number().finite().nonnegative(),
  costKnown: z.boolean(),
  tokens: z.number().finite().nonnegative(),
  unattended: z.boolean().optional(),
  runId: z.string().optional(),
  origin: z.string().optional(),
});

/** Summed spend over a set of runs. */
export interface SpendTotals {
  readonly costUSD: number;
  readonly runs: number;
  readonly tokens: number;
  /** Runs whose price was unknown; their dollars are missing from `costUSD`. */
  readonly unpricedRuns: number;
}

/** One day's spend, whole and broken down. */
export interface DaySpend {
  readonly total: SpendTotals;
  /** The runs nobody could be asked in: what the `daemon` spend caps count. */
  readonly unattended: SpendTotals;
  readonly unattendedByAgent: Readonly<Record<string, SpendTotals>>;
  readonly byAgent: Readonly<Record<string, SpendTotals>>;
  readonly bySource: Readonly<Partial<Record<SpendSource, SpendTotals>>>;
  readonly byOrigin: Readonly<Record<string, SpendTotals>>;
}

/** Today and this month, in the machine's local calendar, plus every retained day. */
export interface SpendReport {
  readonly today: DaySpend;
  readonly month: DaySpend;
  /** Local date of `today` (YYYY-MM-DD). */
  readonly day: string;
  /** Local month of `month` (YYYY-MM). */
  readonly monthKey: string;
  readonly days: Readonly<Record<string, DaySpend>>;
  /** Lines in the day files that could not be read (a torn write, a hand edit). */
  readonly unreadableLines: number;
}

export const EMPTY_TOTALS: SpendTotals = { costUSD: 0, runs: 0, tokens: 0, unpricedRuns: 0 };

export const EMPTY_DAY: DaySpend = {
  total: EMPTY_TOTALS,
  unattended: EMPTY_TOTALS,
  unattendedByAgent: {},
  byAgent: {},
  bySource: {},
  byOrigin: {},
};

const TotalsSchema = z.object({
  costUSD: z.number().finite(),
  runs: z.number().finite(),
  tokens: z.number().finite(),
  unpricedRuns: z.number().finite(),
});

const DaySpendSchema = z.object({
  total: TotalsSchema,
  unattended: TotalsSchema,
  unattendedByAgent: z.record(z.string(), TotalsSchema),
  byAgent: z.record(z.string(), TotalsSchema),
  bySource: z.partialRecord(z.enum(SPEND_SOURCES), TotalsSchema),
  byOrigin: z.record(z.string(), TotalsSchema),
});

/** A day as version 1 stored it, before the unattended totals. */
const DaySpendV1Schema = DaySpendSchema.omit({ unattended: true, unattendedByAgent: true });

type SpendSummary = Readonly<Record<string, DaySpend>>;

/**
 * A version 1 day with its unattended totals derived: the unattended sources' totals summed from
 * `bySource`. The per-agent split by source was not stored, so each agent's unattended spend is
 * taken as its whole spend that day, which can only make an agent cap stricter.
 */
function migrateDayFromV1(day: z.infer<typeof DaySpendV1Schema>): DaySpend {
  const unattended = (Object.entries(day.bySource) as [SpendSource, SpendTotals][])
    .filter(([source]) => isUnattendedBySource(source))
    .reduce((sum, [, totals]) => addTotals(sum, totals), EMPTY_TOTALS);
  return { ...day, unattended, unattendedByAgent: day.byAgent };
}

const SUMMARY_KIND: StateFileKind<SpendSummary> = {
  noun: "spend summary",
  schemaVersion: SUMMARY_SCHEMA_VERSION,
  parse: (document, schemaVersion) => {
    const current = z.object({ days: z.record(z.string(), DaySpendSchema) }).safeParse(document);
    if (current.success) {
      return { ok: true, content: current.data.days };
    }
    if (schemaVersion !== undefined && schemaVersion >= SUMMARY_SCHEMA_VERSION) {
      return { ok: false, error: current.error.message };
    }
    const legacy = z.object({ days: z.record(z.string(), DaySpendV1Schema) }).safeParse(document);
    return legacy.success
      ? {
          ok: true,
          content: Object.fromEntries(
            Object.entries(legacy.data.days).map(([key, day]) => [key, migrateDayFromV1(day)]),
          ),
        }
      : { ok: false, error: legacy.error.message };
  },
  serialize: (days) => ({ days }),
};

/** `$JAZZ_HOME/spend`, or the same under another home. */
export function spendDirectory(home: string = getJazzHomeDirectory()): string {
  return path.join(home, "spend");
}

function daysDirectory(home: string): string {
  return path.join(spendDirectory(home), "days");
}

function summaryPath(home: string): string {
  return path.join(spendDirectory(home), "summary.json");
}

function ledgerLockPath(home: string): string {
  return path.join(spendDirectory(home), "ledger.lock");
}

function inFlightDirectory(home: string): string {
  return path.join(spendDirectory(home), "in-flight");
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** The local calendar date of `epochMs`, as YYYY-MM-DD. */
export function localDayKey(epochMs: number): string {
  const date = new Date(epochMs);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The local calendar month of `epochMs`, as YYYY-MM. */
export function localMonthKey(epochMs: number): string {
  return localDayKey(epochMs).slice(0, 7);
}

function addTotals(left: SpendTotals, right: SpendTotals): SpendTotals {
  return {
    costUSD: parseFloat((left.costUSD + right.costUSD).toFixed(8)),
    runs: left.runs + right.runs,
    tokens: left.tokens + right.tokens,
    unpricedRuns: left.unpricedRuns + right.unpricedRuns,
  };
}

function totalsOf(entry: SpendEntry): SpendTotals {
  return {
    costUSD: entry.costUSD,
    runs: 1,
    tokens: entry.tokens,
    unpricedRuns: entry.costKnown ? 0 : 1,
  };
}

function addToRecord<Key extends string>(
  record: Readonly<Partial<Record<Key, SpendTotals>>>,
  key: Key,
  totals: SpendTotals,
): Partial<Record<Key, SpendTotals>> {
  return { ...record, [key]: addTotals(record[key] ?? EMPTY_TOTALS, totals) };
}

function mergeRecords<Key extends string>(
  left: Readonly<Partial<Record<Key, SpendTotals>>>,
  right: Readonly<Partial<Record<Key, SpendTotals>>>,
): Partial<Record<Key, SpendTotals>> {
  let merged: Partial<Record<Key, SpendTotals>> = { ...left };
  for (const [key, totals] of Object.entries(right) as [Key, SpendTotals][]) {
    merged = addToRecord(merged, key, totals);
  }
  return merged;
}

/** Fold one run into a day. */
export function addEntryToDay(day: DaySpend, entry: SpendEntry): DaySpend {
  const totals = totalsOf(entry);
  return {
    total: addTotals(day.total, totals),
    unattended: entry.unattended ? addTotals(day.unattended, totals) : day.unattended,
    unattendedByAgent: entry.unattended
      ? (addToRecord(day.unattendedByAgent, entry.agentId, totals) as Record<string, SpendTotals>)
      : day.unattendedByAgent,
    byAgent: addToRecord(day.byAgent, entry.agentId, totals) as Record<string, SpendTotals>,
    bySource: addToRecord(day.bySource, entry.source, totals),
    byOrigin:
      entry.origin === undefined
        ? day.byOrigin
        : (addToRecord(day.byOrigin, entry.origin, totals) as Record<string, SpendTotals>),
  };
}

/** Sum two days' spend (a month is the sum of its days). */
export function mergeDays(left: DaySpend, right: DaySpend): DaySpend {
  return {
    total: addTotals(left.total, right.total),
    unattended: addTotals(left.unattended, right.unattended),
    unattendedByAgent: mergeRecords(left.unattendedByAgent, right.unattendedByAgent) as Record<
      string,
      SpendTotals
    >,
    byAgent: mergeRecords(left.byAgent, right.byAgent) as Record<string, SpendTotals>,
    bySource: mergeRecords(left.bySource, right.bySource),
    byOrigin: mergeRecords(left.byOrigin, right.byOrigin) as Record<string, SpendTotals>,
  };
}

/** Parse a day file's lines, skipping any line that is not a ledger entry. */
export function parseDayFile(content: string): {
  readonly entries: readonly SpendEntry[];
  readonly unreadable: number;
} {
  const entries: SpendEntry[] = [];
  let unreadable = 0;
  for (const line of content.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const parsed = SpendEntrySchema.safeParse(JSON.parse(line));
      if (parsed.success) {
        entries.push({
          ...parsed.data,
          unattended: parsed.data.unattended ?? isUnattendedBySource(parsed.data.source),
        } as SpendEntry);
      } else {
        unreadable += 1;
      }
    } catch {
      unreadable += 1;
    }
  }
  return { entries, unreadable };
}

async function readFileOrUndefined(filePath: string): Promise<string | undefined> {
  try {
    return await nodeFs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function listDayFiles(home: string): Promise<readonly string[]> {
  try {
    const names = await nodeFs.readdir(daysDirectory(home));
    return names
      .map((name) => DAY_FILE_PATTERN.exec(name)?.[1])
      .filter((day): day is string => day !== undefined)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/**
 * Append one line and fsync it. A previous append torn mid-line is closed off first, so the
 * new entry starts on a line of its own and only the torn one is lost.
 */
async function appendLineDurably(filePath: string, line: string): Promise<void> {
  await nodeFs.mkdir(path.dirname(filePath), { recursive: true, mode: stateDirectoryMode() });
  const handle = await nodeFs.open(filePath, "a+", stateFileMode());
  try {
    const { size } = await handle.stat();
    let prefix = "";
    if (size > 0) {
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, size - 1);
      prefix = last.toString("utf8") === "\n" ? "" : "\n";
    }
    await handle.write(`${prefix}${line}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function readSummaryLocked(home: string): Effect.Effect<SpendSummary, Error> {
  return readStateFile(summaryPath(home), SUMMARY_KIND, { onCorrupt: "quarantine" }).pipe(
    Effect.map((summary) => summary ?? {}),
  );
}

/**
 * Fold every day file before `today` into the summary, then remove it; drop summary days past
 * {@link RETAINED_SUMMARY_DAYS}. Runs under the ledger's lock.
 */
function compactLocked(home: string, today: string): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const dayFiles = yield* Effect.tryPromise({ try: () => listDayFiles(home), catch: toError });
    const stale = dayFiles.filter((day) => day < today);
    const summary = yield* readSummaryLocked(home);
    const oldestKept = localDayKey(Date.now() - RETAINED_SUMMARY_DAYS * DAY_MS);
    const expired = Object.keys(summary).filter((day) => day < oldestKept);
    if (stale.length === 0 && expired.length === 0) {
      return;
    }
    const next: Record<string, DaySpend> = { ...summary };
    for (const day of expired) {
      delete next[day];
    }
    const compacted: string[] = [];
    for (const day of stale) {
      if (next[day] !== undefined) {
        compacted.push(day);
        continue;
      }
      const content = yield* Effect.tryPromise({
        try: () => readFileOrUndefined(path.join(daysDirectory(home), `${day}.jsonl`)),
        catch: toError,
      });
      const parsed = parseDayFile(content ?? "");
      if (parsed.entries.length === 0 && parsed.unreadable > 0) {
        continue;
      }
      next[day] = parsed.entries.reduce(addEntryToDay, EMPTY_DAY);
      compacted.push(day);
    }
    yield* writeStateFile(summaryPath(home), SUMMARY_KIND, next);
    for (const day of compacted) {
      yield* Effect.tryPromise({
        try: () => nodeFs.rm(path.join(daysDirectory(home), `${day}.jsonl`), { force: true }),
        catch: toError,
      });
    }
  });
}

/**
 * Record one finished run. Compacts earlier days first, so the directory never holds more
 * than today's file plus whatever a crash left behind.
 */
export function recordSpend(
  input: SpendEntryInput,
  home: string = getJazzHomeDirectory(),
): Effect.Effect<void, Error> {
  return withLock(
    ledgerLockPath(home),
    Effect.gen(function* () {
      const now = Date.now();
      const entry: SpendEntry = {
        ...input,
        at: input.at ?? new Date(now).toISOString(),
        costUSD: Number.isFinite(input.costUSD) && input.costUSD > 0 ? input.costUSD : 0,
        tokens: Number.isFinite(input.tokens) && input.tokens > 0 ? Math.round(input.tokens) : 0,
      };
      const day = localDayKey(Date.parse(entry.at));
      yield* compactLocked(home, localDayKey(now));
      yield* Effect.tryPromise({
        try: () =>
          appendLineDurably(path.join(daysDirectory(home), `${day}.jsonl`), JSON.stringify(entry)),
        catch: toError,
      });
    }),
  );
}

/** Compact the ledger now (the daemon does this once a tick; recording does it too). */
export function compactSpendLedger(
  now: number = Date.now(),
  home: string = getJazzHomeDirectory(),
): Effect.Effect<void, Error> {
  return withLock(ledgerLockPath(home), compactLocked(home, localDayKey(now)));
}

function readSpendLocked(now: number, home: string): Effect.Effect<SpendReport, Error> {
  return Effect.gen(function* () {
    const summary = yield* readSummaryLocked(home);
    const days: Record<string, DaySpend> = { ...summary };
    let unreadableLines = 0;
    const dayFiles = yield* Effect.tryPromise({ try: () => listDayFiles(home), catch: toError });
    for (const day of dayFiles) {
      if (summary[day] !== undefined) {
        continue;
      }
      const content = yield* Effect.tryPromise({
        try: () => readFileOrUndefined(path.join(daysDirectory(home), `${day}.jsonl`)),
        catch: toError,
      });
      const parsed = parseDayFile(content ?? "");
      unreadableLines += parsed.unreadable;
      days[day] = parsed.entries.reduce(addEntryToDay, days[day] ?? EMPTY_DAY);
    }
    const day = localDayKey(now);
    const monthKey = localMonthKey(now);
    const month = Object.entries(days)
      .filter(([key]) => key.startsWith(monthKey))
      .reduce((sum, [, spend]) => mergeDays(sum, spend), EMPTY_DAY);
    return {
      today: days[day] ?? EMPTY_DAY,
      month,
      day,
      monthKey,
      days,
      unreadableLines,
    };
  });
}

/** Today's and this month's spend, from the summary plus any day files not yet compacted. */
export function readSpend(
  now: number = Date.now(),
  home: string = getJazzHomeDirectory(),
): Effect.Effect<SpendReport, Error> {
  return withLock(ledgerLockPath(home), readSpendLocked(now, home));
}

/** A run that passed the cap check and has not finished, counted at its estimated cost. */
export interface InFlightRun {
  readonly id: string;
  readonly pid: number;
  /** ISO time the reservation was taken. */
  readonly startedAt: string;
  readonly agentId: string;
  readonly source: SpendSource;
  readonly costUSD: number;
  readonly tokens: number;
}

/** What a caller reserves: the ledger stamps the pid and the time. */
export type InFlightReservation = Omit<InFlightRun, "pid" | "startedAt">;

const InFlightRunSchema = z.object({
  id: z.string(),
  pid: z.number().int().positive(),
  startedAt: z.string(),
  agentId: z.string(),
  source: z.enum(SPEND_SOURCES),
  costUSD: z.number().finite().nonnegative(),
  tokens: z.number().finite().nonnegative(),
});

function inFlightPath(home: string, id: string): string {
  return path.join(inFlightDirectory(home), `${id}.json`);
}

function isLive(run: InFlightRun, now: number): boolean {
  const startedAt = Date.parse(run.startedAt);
  return (
    Number.isFinite(startedAt) && now - startedAt < IN_FLIGHT_MAX_AGE_MS && isProcessAlive(run.pid)
  );
}

function parseInFlightRun(content: string): InFlightRun | undefined {
  try {
    const parsed = InFlightRunSchema.safeParse(JSON.parse(content));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The live reservations; a stale or unreadable one is removed. Runs under the ledger's lock. */
async function liveInFlightRuns(home: string, now: number): Promise<InFlightRun[]> {
  let names: string[];
  try {
    names = await nodeFs.readdir(inFlightDirectory(home));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const live: InFlightRun[] = [];
  for (const name of names.filter((candidate) => candidate.endsWith(".json"))) {
    const filePath = path.join(inFlightDirectory(home), name);
    const content = await readFileOrUndefined(filePath);
    if (content === undefined) {
      continue;
    }
    const run = parseInFlightRun(content);
    if (run !== undefined && isLive(run, now)) {
      live.push(run);
    } else {
      await nodeFs.rm(filePath, { force: true });
    }
  }
  return live;
}

/** A report with the in-flight runs folded into today and this month, as unattended priced runs. */
function withInFlight(report: SpendReport, runs: readonly InFlightRun[]): SpendReport {
  const entries: SpendEntry[] = runs.map((run) => ({
    at: run.startedAt,
    agentId: run.agentId,
    source: run.source,
    costUSD: run.costUSD,
    costKnown: true,
    tokens: run.tokens,
    unattended: true,
  }));
  return {
    ...report,
    today: entries.reduce(addEntryToDay, report.today),
    month: entries.reduce(addEntryToDay, report.month),
  };
}

/**
 * Decide on a run against the ledger plus every live in-flight reservation, and hold a
 * reservation for it when `decide` returns one, all under the ledger's lock: two runs checked at
 * the same moment see each other.
 */
export function checkAndReserveSpend<Outcome>(
  decide: (spend: SpendReport) => {
    readonly outcome: Outcome;
    readonly reservation?: InFlightReservation;
  },
  options: { readonly now?: number; readonly home?: string } = {},
): Effect.Effect<Outcome, Error> {
  const home = options.home ?? getJazzHomeDirectory();
  const now = options.now ?? Date.now();
  return withLock(
    ledgerLockPath(home),
    Effect.gen(function* () {
      const report = yield* readSpendLocked(now, home);
      const inFlight = yield* Effect.tryPromise({
        try: () => liveInFlightRuns(home, now),
        catch: toError,
      });
      const decision = decide(withInFlight(report, inFlight));
      const reservation = decision.reservation;
      if (reservation !== undefined) {
        if (!isValidStorageKey(reservation.id)) {
          return yield* Effect.fail(
            new Error(`Invalid in-flight reservation id: ${reservation.id}`),
          );
        }
        const stored: InFlightRun = {
          ...reservation,
          pid: process.pid,
          startedAt: new Date(now).toISOString(),
        };
        yield* writeFileStringAtomic(inFlightPath(home, reservation.id), JSON.stringify(stored));
      }
      return decision.outcome;
    }),
  );
}

/** Drop a run's in-flight reservation, once its spend is recorded or it never started. */
export function releaseInFlightSpend(
  id: string,
  home: string = getJazzHomeDirectory(),
): Effect.Effect<void, Error> {
  if (!isValidStorageKey(id)) {
    return Effect.void;
  }
  return Effect.tryPromise({
    try: () => nodeFs.rm(inFlightPath(home, id), { force: true }),
    catch: toError,
  });
}
