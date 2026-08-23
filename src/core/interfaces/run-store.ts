import { Context, Effect } from "effect";
import type { RunRecord } from "@/core/agent/run/run-record";
import type { RunId, RunState } from "@/core/agent/run/run-state";

/**
 * Where run lifecycle records live.
 *
 * Two implementations, and which one is in the layer is the whole difference between the
 * surfaces. The terminal holds one process open for the length of a run and never needs
 * to answer a question about it from outside, so it takes the in-memory store and pays
 * nothing. Anything unattended — a scheduled run, a bridge, a daemon — takes the file
 * store, because the process that started the run is not necessarily the one that will
 * finish it.
 */
export interface RunStore {
  readonly save: (record: RunRecord) => Effect.Effect<void, never>;
  readonly get: (runId: RunId) => Effect.Effect<RunRecord | undefined, never>;
  /**
   * Move a run to a new state and stamp `updatedAt`.
   *
   * Fails loudly on an illegal move rather than writing it: the store is the last place
   * that can tell a lifecycle bug from a legitimate state, and a record that claims a run
   * went straight from `completed` back to `working` is worse than no record.
   */
  readonly transition: (runId: RunId, next: RunState) => Effect.Effect<RunRecord, Error>;
  /** Runs not in a terminal state, newest first. What "what is running right now" reads. */
  readonly listActive: (filter?: {
    readonly agentId?: string;
  }) => Effect.Effect<readonly RunRecord[], never>;
  /**
   * Housekeeping sweep, run before any listing so nothing stale is ever shown.
   *
   * Three jobs: re-park runs whose resuming process died, so a crash costs a retry instead
   * of the work; move parked runs past their deadline to `failed`/`abandoned`; and delete
   * terminal records older than `maxTerminalAgeMs`. Returns how many of each it touched.
   */
  readonly prune: (options: {
    readonly now: Date;
    readonly maxTerminalAgeMs: number;
  }) => Effect.Effect<
    { readonly abandoned: number; readonly deleted: number; readonly reparked: number },
    never
  >;
}

export class RunStoreTag extends Context.Tag("RunStore")<RunStoreTag, RunStore>() {}
