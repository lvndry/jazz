/**
 * The daemon's own state, `$JAZZ_HOME/daemon-state.json`: whether it is paused and which waiting
 * items it has announced. Read and changed by the daemon and by `jazz daemon pause|resume`, so
 * every change is a read-modify-write under a cross-process lock.
 */

import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import {
  EMPTY_DAEMON_STATE,
  parseDaemonState,
  type DaemonState,
} from "@jazz/core/daemon/attention";
import { toError } from "@jazz/core/utils/errors";
import { getJazzHomeDirectory } from "@jazz/core/utils/paths";
import { Effect } from "effect";
import { writeJsonFileDurably } from "./durable-file";
import { withFileLock } from "./file-lock";

const STATE_FILE = "daemon-state.json";

function statePath(): string {
  return path.join(getJazzHomeDirectory(), STATE_FILE);
}

async function readState(file: string): Promise<DaemonState> {
  try {
    return parseDaemonState(JSON.parse(await nodeFs.readFile(file, "utf-8")) as unknown);
  } catch {
    return EMPTY_DAEMON_STATE;
  }
}

/** The stored state, or the empty one when there is none yet. */
export function readDaemonState(): Effect.Effect<DaemonState> {
  return Effect.promise(() => readState(statePath()));
}

/** Change the state under its lock and return what was stored. */
export function updateDaemonState(
  change: (state: DaemonState) => DaemonState,
): Effect.Effect<DaemonState, Error> {
  return Effect.tryPromise({
    try: async () => {
      const file = statePath();
      await nodeFs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      return withFileLock(`${file}.lock.d`, async () => {
        const next = change(await readState(file));
        await writeJsonFileDurably(file, next);
        return next;
      });
    },
    catch: toError,
  });
}
