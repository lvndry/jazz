/**
 * Implements `OccupancyService`: the machine-wide "who is jazz working where, right now"
 * registry at `$JAZZ_HOME/occupancy.json`.
 *
 * Every jazz process running a turn heartbeats its entry here; a terminal session, a daemon
 * run and a worktree run all land in the same file, which is the whole point — the run
 * stores are per-process, this one is not.
 *
 * The file is a map of `runId -> entry`. Presence is judged by the reader, not the writer:
 * entries are kept while fresh (three heartbeat intervals) or until a terminal-state entry
 * has aged out. Writes are locked read-modify-write like `state.json`, so two processes
 * heartbeating at the same instant both land, and a corrupt file is quarantined rather than
 * overwritten. A reader that sees a torn file from a crash reads an empty registry: nobody
 * is "here" until someone heartbeats again, which is the safe answer to a collision check.
 */

import * as path from "node:path";
import { OCCUPANCY_FRESH_WINDOW_MS } from "@jazz/core/agent/run/run-recorder";
import { OccupancyServiceTag, type OccupancyService } from "@jazz/core/interfaces/occupancy";
import type { OccupancyEntry } from "@jazz/core/types/occupancy";
import { isRecord } from "@jazz/core/utils/is-record";
import { getJazzHomeDirectory } from "@jazz/core/utils/paths";
import { readStateFile, writeStateFile, type StateFileKind } from "@jazz/core/utils/state-file";
import { withLock } from "@jazz/core/utils/storage";
import { Effect, Layer } from "effect";

const OCCUPANCY_FILE_KIND: StateFileKind<Record<string, OccupancyEntry>> = {
  noun: "occupancy entries",
  schemaVersion: 1,
  parse: (document) => {
    if (!isRecord(document)) {
      return { ok: false, error: "expected an object" };
    }
    const { schemaVersion: _schemaVersion, ...entries } = document;
    if (!isRecord(entries)) {
      return { ok: false, error: "expected an object of entries" };
    }
    return { ok: true, content: entries as Record<string, OccupancyEntry> };
  },
  serialize: (entries) => entries,
};

/** Terminal-state entries are kept for a few intervals so a just-finished run is visible,
 *  then dropped: the answer to "is anyone working here" must not be "the run of 20 minutes
 *  ago". */
const TERMINAL_ENTRY_TTL_MS = 5 * 60_000;
const TERMINAL_STATES = new Set(["completed", "failed", "canceled"]);

export interface OccupancyServiceOptions {
  /** Override for tests; defaults to `$JAZZ_HOME/occupancy.json`. */
  readonly filePath?: string;
}

export function createOccupancyServiceLayer(
  options: OccupancyServiceOptions = {},
): Layer.Layer<OccupancyService> {
  const filePath = options.filePath ?? path.join(getJazzHomeDirectory(), "occupancy.json");
  const lockPath = `${filePath}.lock`;
  const readEntries = readStateFile(filePath, OCCUPANCY_FILE_KIND, {
    onCorrupt: "quarantine",
  }).pipe(Effect.map((entries) => entries ?? {}));

  const prune = (entries: Record<string, OccupancyEntry>): Record<string, OccupancyEntry> => {
    const now = Date.now();
    const kept: Record<string, OccupancyEntry> = {};
    for (const [runId, entry] of Object.entries(entries)) {
      const updated = Date.parse(entry.updatedAt);
      if (Number.isNaN(updated)) continue;
      const ageMs = now - updated;
      if (TERMINAL_STATES.has(entry.state)) {
        if (ageMs < TERMINAL_ENTRY_TTL_MS) kept[runId] = entry;
      } else if (ageMs < OCCUPANCY_FRESH_WINDOW_MS) {
        kept[runId] = entry;
      }
    }
    return kept;
  };

  return Layer.succeed(OccupancyServiceTag, {
    record: (entry) =>
      withLock(
        lockPath,
        Effect.gen(function* () {
          const current = yield* readEntries;
          current[entry.runId] = entry;
          yield* writeStateFile(filePath, OCCUPANCY_FILE_KIND, prune(current));
        }),
      ).pipe(Effect.ignore),

    list: (): Effect.Effect<readonly OccupancyEntry[], never> =>
      withLock(
        lockPath,
        Effect.gen(function* () {
          const current = yield* readEntries;
          return Object.values(prune(current));
        }),
      ).pipe(Effect.catchAll(() => Effect.succeed([]))),
  });
}
