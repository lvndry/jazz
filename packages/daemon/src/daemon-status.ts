/**
 * What a running daemon says about itself, for `jazz daemon status`.
 *
 * The foreground daemon writes `$JAZZ_HOME/runtime/daemon-<port>.status.json` when it starts
 * and after every tick: its pid, bind, when it started, when the last tick ran and how long it
 * took, whether a tick is running now, how many goal cycles and loop runs it is executing, and
 * the last few tick failures. A file rather than an HTTP route because the status names the
 * work in flight and its errors, and `/health` is the one route that answers without a token;
 * the file is private to the owner like everything else in the home.
 *
 * The record is written by rename, so a reader sees one whole version, and removed when the
 * daemon stops. A record whose pid is gone is a daemon that died without stopping, which
 * `jazz daemon status` reports as such.
 */

import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import { getJazzHomeDirectory } from "@jazz/core/utils/paths";

/** Tick failures kept in the status record, newest last. */
export const DAEMON_STATUS_RECENT_ERRORS = 10;

export interface DaemonTickError {
  readonly at: string;
  /** Which part of the tick failed: `trigger`, `goal`, or `loop`. */
  readonly work: string;
  readonly message: string;
}

export interface DaemonStatusRecord {
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly startedAt: string;
  readonly servesPeers: boolean;
  readonly tickIntervalMs: number;
  readonly lastTickStartedAt?: string;
  readonly lastTickDurationMs?: number;
  readonly tickRunning: boolean;
  /** Goal cycles and loop runs this daemon is executing right now. */
  readonly runsInFlight: number;
  readonly recentErrors: readonly DaemonTickError[];
}

export function daemonStatusPath(port: number): string {
  return path.join(getJazzHomeDirectory(), "runtime", `daemon-${String(port)}.status.json`);
}

/** Replaces the status record. Never throws: status is for people, and must not stop a tick. */
export async function writeDaemonStatus(record: DaemonStatusRecord): Promise<void> {
  const filePath = daemonStatusPath(record.port);
  const temporaryPath = `${filePath}.${String(process.pid)}.tmp`;
  try {
    await nodeFs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await nodeFs.writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
    });
    await nodeFs.rename(temporaryPath, filePath);
  } catch {
    await nodeFs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function readDaemonStatus(port: number): Promise<DaemonStatusRecord | undefined> {
  try {
    const parsed: unknown = JSON.parse(await nodeFs.readFile(daemonStatusPath(port), "utf-8"));
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    const record = parsed as Partial<DaemonStatusRecord>;
    if (typeof record.pid !== "number" || typeof record.port !== "number") {
      return undefined;
    }
    return {
      pid: record.pid,
      host: typeof record.host === "string" ? record.host : "",
      port: record.port,
      startedAt: typeof record.startedAt === "string" ? record.startedAt : "",
      servesPeers: record.servesPeers === true,
      tickIntervalMs: typeof record.tickIntervalMs === "number" ? record.tickIntervalMs : 0,
      ...(typeof record.lastTickStartedAt === "string"
        ? { lastTickStartedAt: record.lastTickStartedAt }
        : {}),
      ...(typeof record.lastTickDurationMs === "number"
        ? { lastTickDurationMs: record.lastTickDurationMs }
        : {}),
      tickRunning: record.tickRunning === true,
      runsInFlight: typeof record.runsInFlight === "number" ? record.runsInFlight : 0,
      recentErrors: Array.isArray(record.recentErrors) ? record.recentErrors : [],
    };
  } catch {
    return undefined;
  }
}

export async function clearDaemonStatus(port: number): Promise<void> {
  await nodeFs.rm(daemonStatusPath(port), { force: true }).catch(() => undefined);
}

/** Appends a tick failure, keeping the newest `DAEMON_STATUS_RECENT_ERRORS`. */
export function withTickError(
  errors: readonly DaemonTickError[],
  error: DaemonTickError,
): readonly DaemonTickError[] {
  return [...errors, error].slice(-DAEMON_STATUS_RECENT_ERRORS);
}
