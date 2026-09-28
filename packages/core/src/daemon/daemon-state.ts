/**
 * Where the daemon's own state lives (`$JAZZ_HOME/daemon-state.json`) and reading it. Writes go
 * through `daemon-state-store.ts` in adapters, under the file's lock; any process may read it,
 * which is how a `jazz run` honors a daily cap the person lifted with `jazz daemon resume`.
 */

import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import { getJazzHomeDirectory } from "@/core/utils/paths";
import { EMPTY_DAEMON_STATE, parseDaemonState, type DaemonState } from "./attention";

const DAEMON_STATE_FILE = "daemon-state.json";

export function daemonStatePath(home: string = getJazzHomeDirectory()): string {
  return path.join(home, DAEMON_STATE_FILE);
}

/** The stored state, or the empty one for a missing or unreadable file. */
export async function readDaemonStateFile(file: string): Promise<DaemonState> {
  try {
    return parseDaemonState(JSON.parse(await nodeFs.readFile(file, "utf-8")) as unknown);
  } catch {
    return EMPTY_DAEMON_STATE;
  }
}
