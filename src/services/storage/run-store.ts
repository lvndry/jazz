/**
 * @fileoverview Run lifecycle storage: one in memory, one on disk.
 *
 * Records are written on every transition, so the file store keeps them small and
 * self-contained — one JSON file per run, no index to keep in step, no append log to
 * compact. A listing reads the directory; at the volume one person's agents produce that
 * is cheaper than the bookkeeping an index would need.
 */

import * as nodeFs from "node:fs/promises";
import { hostname } from "node:os";
import * as path from "node:path";
import { Effect, Layer } from "effect";
import type { RunRecord } from "@/core/agent/run/run-record";
import {
  isParked,
  isTerminal,
  transition,
  type RunId,
  type RunState,
} from "@/core/agent/run/run-state";
import { RunStoreTag, type RunStore } from "@/core/interfaces/run-store";
import { getRunsDirectory } from "@/core/utils/paths";

/** Run ids are UUIDs; anything else came from outside and must not reach a path join. */
const RUN_ID_PATTERN = /^[0-9a-fA-F-]{8,64}$/;

/**
 * A record that will not parse is treated as absent rather than fatal: a half-written or
 * hand-edited file should cost one run's history, not every listing that walks past it.
 */
function readRecord(raw: string): RunRecord | undefined {
  try {
    return JSON.parse(raw) as RunRecord;
  } catch {
    return undefined;
  }
}

function withState(record: RunRecord, next: RunState, now: Date): RunRecord {
  return {
    ...record,
    state: transition(record.state, next),
    updatedAt: now.toISOString(),
  };
}

function isExpired(record: RunRecord, now: Date): boolean {
  if (!isParked(record.state)) return false;
  const expiresAt = "expiresAt" in record.state ? record.state.expiresAt : undefined;
  if (expiresAt === undefined) return false;
  const deadline = new Date(expiresAt).getTime();
  return Number.isFinite(deadline) && deadline <= now.getTime();
}

/**
 * Whether the process that claimed a run is still alive.
 *
 * `kill(pid, 0)` sends no signal; it only asks whether the pid is addressable. EPERM means
 * the process exists but belongs to someone else — still alive, so still working. A record
 * written on another machine is never judged from here: its pid means nothing locally, and
 * re-parking a run that is happily working elsewhere would run its tool twice.
 */
function ownerIsGone(recovery: { readonly pid: number; readonly host: string }): boolean {
  if (recovery.host !== hostname()) return false;
  try {
    process.kill(recovery.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "EPERM";
  }
}

/**
 * A run whose owner died goes back to where it was, not to failed.
 *
 * The approval is still unanswered and the transcript is still intact, so the honest state
 * is the one it was in before somebody tried to resume it.
 */
function recoveredState(record: RunRecord): RunState | undefined {
  if (record.state.kind !== "working") return undefined;
  const { recovery } = record.state;
  if (recovery === undefined || !ownerIsGone(recovery)) return undefined;
  return {
    kind: "input-required",
    pending: recovery.pending,
    snapshot: recovery.snapshot,
    expiresAt: recovery.expiresAt,
  };
}

const ABANDONED: RunState = {
  kind: "failed",
  cause: "abandoned",
  error: "Parked waiting for a person, and the deadline passed with no answer.",
};

function byNewestFirst(left: RunRecord, right: RunRecord): number {
  return right.createdAt.localeCompare(left.createdAt);
}

/** Injected so a test can assert the exact stamp, and so both stores agree on one source of time. */
export type Clock = () => Date;

const SYSTEM_CLOCK: Clock = () => new Date();

export class InMemoryRunStore implements RunStore {
  private readonly records = new Map<RunId, RunRecord>();

  constructor(private readonly clock: Clock = SYSTEM_CLOCK) {}

  save(record: RunRecord): Effect.Effect<void, never> {
    return Effect.sync(() => {
      this.records.set(record.runId, record);
    });
  }

  get(runId: RunId): Effect.Effect<RunRecord | undefined, never> {
    return Effect.sync(() => this.records.get(runId));
  }

  transition(runId: RunId, next: RunState): Effect.Effect<RunRecord, Error> {
    return Effect.try({
      try: () => {
        const existing = this.records.get(runId);
        if (existing === undefined) {
          throw new Error(`No run with id "${runId}".`);
        }
        const updated = withState(existing, next, this.clock());
        this.records.set(runId, updated);
        return updated;
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });
  }

  listActive(filter?: { readonly agentId?: string }): Effect.Effect<readonly RunRecord[], never> {
    return Effect.sync(() =>
      [...this.records.values()]
        .filter((record) => !isTerminal(record.state))
        .filter((record) => filter?.agentId === undefined || record.agentId === filter.agentId)
        .sort(byNewestFirst),
    );
  }

  prune(options: {
    readonly now: Date;
    readonly maxTerminalAgeMs: number;
  }): Effect.Effect<
    { readonly abandoned: number; readonly deleted: number; readonly reparked: number },
    never
  > {
    return Effect.sync(() => {
      let abandoned = 0;
      let deleted = 0;
      let reparked = 0;
      for (const [runId, record] of [...this.records]) {
        const recovered = recoveredState(record);
        if (recovered !== undefined) {
          this.records.set(runId, withState(record, recovered, options.now));
          reparked += 1;
          continue;
        }
        if (isExpired(record, options.now)) {
          this.records.set(runId, withState(record, ABANDONED, options.now));
          abandoned += 1;
          continue;
        }
        if (
          isTerminal(record.state) &&
          options.now.getTime() - new Date(record.updatedAt).getTime() > options.maxTerminalAgeMs
        ) {
          this.records.delete(runId);
          deleted += 1;
        }
      }
      return { abandoned, deleted, reparked };
    });
  }
}

export class FileRunStore implements RunStore {
  constructor(
    private readonly directory: string = getRunsDirectory(),
    private readonly clock: Clock = SYSTEM_CLOCK,
  ) {}

  private pathFor(runId: RunId): string {
    if (!RUN_ID_PATTERN.test(runId)) {
      throw new Error(`"${runId}" is not a usable run id.`);
    }
    return path.join(this.directory, `${runId}.json`);
  }

  private readAll(): Effect.Effect<readonly RunRecord[], never> {
    return Effect.tryPromise({
      try: async () => {
        const entries = await nodeFs.readdir(this.directory);
        const records: RunRecord[] = [];
        for (const entry of entries) {
          if (!entry.endsWith(".json")) continue;
          const raw = await nodeFs.readFile(path.join(this.directory, entry), "utf-8");
          const parsed = readRecord(raw);
          if (parsed !== undefined) records.push(parsed);
        }
        return records;
      },
      catch: (error) => error,
    }).pipe(Effect.catchAll(() => Effect.succeed([] as readonly RunRecord[])));
  }

  save(record: RunRecord): Effect.Effect<void, never> {
    return Effect.tryPromise({
      try: async () => {
        await nodeFs.mkdir(this.directory, { recursive: true });
        const destination = this.pathFor(record.runId);
        // A reader polling mid-write would otherwise parse a truncated record as a
        // missing one, which for a parked run reads as "your approval is gone".
        const temporary = `${destination}.${process.pid}.tmp`;
        await nodeFs.writeFile(temporary, JSON.stringify(record, null, 2), "utf-8");
        await nodeFs.rename(temporary, destination);
      },
      catch: (error) => error,
    }).pipe(Effect.catchAll(() => Effect.void));
  }

  get(runId: RunId): Effect.Effect<RunRecord | undefined, never> {
    return Effect.tryPromise({
      try: () => nodeFs.readFile(this.pathFor(runId), "utf-8"),
      catch: (error) => error,
    }).pipe(
      Effect.map(readRecord),
      Effect.catchAll(() => Effect.succeed(undefined)),
    );
  }

  transition(runId: RunId, next: RunState): Effect.Effect<RunRecord, Error> {
    return Effect.gen(this, function* () {
      const existing = yield* this.get(runId);
      if (existing === undefined) {
        return yield* Effect.fail(new Error(`No run with id "${runId}".`));
      }
      const updated = yield* Effect.try({
        try: () => withState(existing, next, this.clock()),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      });
      yield* this.save(updated);
      return updated;
    });
  }

  listActive(filter?: { readonly agentId?: string }): Effect.Effect<readonly RunRecord[], never> {
    return this.readAll().pipe(
      Effect.map((records) =>
        records
          .filter((record) => !isTerminal(record.state))
          .filter((record) => filter?.agentId === undefined || record.agentId === filter.agentId)
          .sort(byNewestFirst),
      ),
    );
  }

  prune(options: {
    readonly now: Date;
    readonly maxTerminalAgeMs: number;
  }): Effect.Effect<
    { readonly abandoned: number; readonly deleted: number; readonly reparked: number },
    never
  > {
    return Effect.gen(this, function* () {
      const records = yield* this.readAll();
      let abandoned = 0;
      let deleted = 0;
      let reparked = 0;
      for (const record of records) {
        const recovered = recoveredState(record);
        if (recovered !== undefined) {
          yield* this.save(withState(record, recovered, options.now));
          reparked += 1;
          continue;
        }
        if (isExpired(record, options.now)) {
          yield* this.save(withState(record, ABANDONED, options.now));
          abandoned += 1;
          continue;
        }
        if (
          isTerminal(record.state) &&
          options.now.getTime() - new Date(record.updatedAt).getTime() > options.maxTerminalAgeMs
        ) {
          yield* Effect.tryPromise({
            try: () => nodeFs.rm(this.pathFor(record.runId), { force: true }),
            catch: (error) => error,
          }).pipe(Effect.catchAll(() => Effect.void));
          deleted += 1;
        }
      }
      return { abandoned, deleted, reparked };
    });
  }
}

export function makeInMemoryRunStoreLayer(): Layer.Layer<RunStoreTag> {
  return Layer.succeed(RunStoreTag, new InMemoryRunStore());
}

export function makeFileRunStoreLayer(directory?: string): Layer.Layer<RunStoreTag> {
  return Layer.succeed(RunStoreTag, new FileRunStore(directory));
}
