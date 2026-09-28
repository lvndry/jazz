/**
 * The daemon's own state, `$JAZZ_HOME/daemon-state.json`: whether it is paused and which waiting
 * items it has announced. Read and changed by the daemon and by `jazz daemon pause|resume`, so
 * every change is a read-modify-write under a cross-process lock.
 */

import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import type { DaemonState } from "@jazz/core/daemon/attention";
import { daemonStatePath, readDaemonStateFile } from "@jazz/core/daemon/daemon-state";
import { writeJsonFileDurably } from "@jazz/core/utils/durable-file";
import { toError } from "@jazz/core/utils/errors";
import { withFileLock } from "@jazz/core/utils/file-lock";
import { stateDirectoryMode } from "@jazz/core/utils/private-mode";
import { Effect } from "effect";

/** The stored state, or the empty one when there is none yet. */
export function readDaemonState(): Effect.Effect<DaemonState> {
  return Effect.promise(() => readDaemonStateFile(daemonStatePath()));
}

/** Change the state under its lock and return what was stored. */
export function updateDaemonState(
  change: (state: DaemonState) => DaemonState,
): Effect.Effect<DaemonState, Error> {
  return Effect.tryPromise({
    try: async () => {
      const file = daemonStatePath();
      await nodeFs.mkdir(path.dirname(file), { recursive: true, mode: stateDirectoryMode() });
      return withFileLock(`${file}.lock.d`, async () => {
        const next = change(await readDaemonStateFile(file));
        await writeJsonFileDurably(file, next);
        return next;
      });
    },
    catch: toError,
  });
}
