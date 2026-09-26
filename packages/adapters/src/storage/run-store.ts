/**
 * @fileoverview Run lifecycle storage: one in memory, one on disk.
 *
 * Records are written on every transition, so the file store keeps them small and
 * self-contained — one JSON file per run, no index to keep in step, no append log to
 * compact. A listing reads the directory; at the volume one person's agents produce that
 * is cheaper than the bookkeeping an index would need.
 */

import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import type { RunRecord } from "@jazz/core/agent/run/run-record";
import {
  isParked,
  isTerminal,
  recoveredState,
  transition,
  type RunId,
  type RunState,
} from "@jazz/core/agent/run/run-state";
import { RunStoreTag, type RunStore } from "@jazz/core/interfaces/run-store";
import { toError } from "@jazz/core/utils/errors";
import { getRunsDirectory } from "@jazz/core/utils/paths";
import { Effect, Layer } from "effect";
import { writeJsonFileDurably } from "./durable-file";
import { acquireFileLock } from "./file-lock";

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

const ABANDONED: RunState = {
  kind: "failed",
  cause: "abandoned",
  error: "Parked waiting for a person, and the deadline passed with no answer.",
};

function byNewestFirst(left: RunRecord, right: RunRecord): number {
  return right.createdAt.localeCompare(left.createdAt);
}

interface RunListFilter {
  readonly agentId?: string;
  readonly conversationId?: string;
  readonly includeTerminal?: boolean;
}

function selectRecords(
  records: readonly RunRecord[],
  filter: RunListFilter | undefined,
): readonly RunRecord[] {
  return records
    .filter((record) => filter?.includeTerminal === true || !isTerminal(record.state))
    .filter((record) => filter?.agentId === undefined || record.agentId === filter.agentId)
    .filter(
      (record) =>
        filter?.conversationId === undefined || record.conversationId === filter.conversationId,
    )
    .sort(byNewestFirst);
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

  transition(
    runId: RunId,
    next: RunState,
    alongside: (record: RunRecord) => RunRecord = (record) => record,
  ): Effect.Effect<RunRecord, Error> {
    return Effect.try({
      try: () => {
        const existing = this.records.get(runId);
        if (existing === undefined) {
          throw new Error(`No run with id "${runId}".`);
        }
        const updated = alongside(withState(existing, next, this.clock()));
        this.records.set(runId, updated);
        return updated;
      },
      catch: toError,
    });
  }

  list(filter?: RunListFilter): Effect.Effect<readonly RunRecord[], never> {
    return Effect.sync(() => selectRecords([...this.records.values()], filter));
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
        const recovered = recoveredState(record.state);
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

  private lockPathFor(runId: RunId): string {
    return `${this.pathFor(runId)}.lock.d`;
  }

  /**
   * Written durably because a reader polling mid-write would otherwise parse a truncated record
   * as a missing one, which for a parked run reads as "your approval is gone".
   */
  private writeRecordFile(record: RunRecord): Promise<void> {
    return writeJsonFileDurably(this.pathFor(record.runId), record);
  }

  /** Serializes read-modify-write on one run id across processes so a losing writer's update isn't silently dropped. */
  private withRunLock<A, E>(runId: RunId, use: Effect.Effect<A, E>): Effect.Effect<A, E | Error> {
    return Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => acquireFileLock(this.lockPathFor(runId)),
        catch: toError,
      }),
      () => use,
      (release) => Effect.promise(() => release()),
    );
  }

  save(record: RunRecord): Effect.Effect<void, never> {
    return this.withRunLock(
      record.runId,
      Effect.tryPromise({
        try: () => this.writeRecordFile(record),
        catch: (error) => error,
      }),
    ).pipe(Effect.catchAll(() => Effect.void));
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

  transition(
    runId: RunId,
    next: RunState,
    alongside: (record: RunRecord) => RunRecord = (record) => record,
  ): Effect.Effect<RunRecord, Error> {
    return this.withRunLock(
      runId,
      Effect.gen(this, function* () {
        const existing = yield* this.get(runId);
        if (existing === undefined) {
          return yield* Effect.fail(new Error(`No run with id "${runId}".`));
        }
        const updated = yield* Effect.try({
          try: () => alongside(withState(existing, next, this.clock())),
          catch: toError,
        });
        yield* Effect.tryPromise({
          try: () => this.writeRecordFile(updated),
          catch: toError,
        });
        return updated;
      }),
    );
  }

  list(filter?: RunListFilter): Effect.Effect<readonly RunRecord[], never> {
    return this.readAll().pipe(Effect.map((records) => selectRecords(records, filter)));
  }

  /**
   * `readAll()` only enumerates which run ids might need pruning; the decision itself is
   * re-made here against a freshly locked read, so a run a live process just moved past
   * (say, to `completed`) can't be reparked or abandoned from the stale snapshot.
   */
  private prunableRunOutcome(
    runId: RunId,
    now: Date,
    maxTerminalAgeMs: number,
  ): Effect.Effect<"abandoned" | "deleted" | "reparked" | "kept", Error> {
    return this.withRunLock(
      runId,
      Effect.gen(this, function* () {
        const current = yield* this.get(runId);
        if (current === undefined) return "kept" as const;

        const recovered = recoveredState(current.state);
        if (recovered !== undefined) {
          yield* Effect.tryPromise({
            try: () => this.writeRecordFile(withState(current, recovered, now)),
            catch: toError,
          });
          return "reparked" as const;
        }

        if (isExpired(current, now)) {
          yield* Effect.tryPromise({
            try: () => this.writeRecordFile(withState(current, ABANDONED, now)),
            catch: toError,
          });
          return "abandoned" as const;
        }

        if (
          isTerminal(current.state) &&
          now.getTime() - new Date(current.updatedAt).getTime() > maxTerminalAgeMs
        ) {
          yield* Effect.tryPromise({
            try: () => nodeFs.rm(this.pathFor(runId), { force: true }),
            catch: toError,
          });
          return "deleted" as const;
        }

        return "kept" as const;
      }),
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
        const outcome = yield* this.prunableRunOutcome(
          record.runId,
          options.now,
          options.maxTerminalAgeMs,
        ).pipe(Effect.catchAll(() => Effect.succeed("kept" as const)));
        if (outcome === "reparked") reparked += 1;
        else if (outcome === "abandoned") abandoned += 1;
        else if (outcome === "deleted") deleted += 1;
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
