/**
 * @fileoverview `jazz daemon status` and `jazz daemon logs`: whether the daemon is working, and
 * what it said.
 *
 * `status` joins four sources, each answering part of the question: the `/health` probe (is
 * something serving this port, and is it this Jazz home's daemon), the pidfile, the status
 * record the daemon writes every tick (`@jazz/adapters/daemon/daemon-status`: last tick, runs
 * in flight, recent tick failures), and whether systemd or launchd supervises it. It also
 * counts the reminders, wake triggers and job batches waiting on it. Exit code 0 when this
 * home's daemon answers, 1 otherwise, so a script can check it.
 *
 * `logs` prints the end of `$JAZZ_HOME/logs/daemon.log`, where a background daemon and the
 * launchd service write, and `-f` follows it across rotation. Under systemd the service logs
 * to the journal instead, so `logs` runs `journalctl` for it.
 */

import { existsSync } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { readDaemonStatus, type DaemonStatusRecord } from "@jazz/adapters/daemon/daemon-status";
import {
  detectInitSystem,
  isDaemonSupervised,
  SYSTEMD_SERVICE_NAME,
} from "@jazz/adapters/daemon/service-install";
import { getJazzInstanceId } from "@jazz/core/utils/instance-id";
import { isProcessAlive } from "@jazz/core/utils/process";
import { Effect } from "effect";
import { backgroundDaemonLogPath } from "@/cli/commands/daemon";
import { readDaemonAttention, formatDaemonAttention } from "@/cli/commands/daemon-attention";
import { collectBatches, collectReminders, collectTriggers } from "@/cli/commands/pending";
import { probeDaemonOwner, readDaemonPid } from "@/cli/helpers/daemon-process";
import { emitEnvelope } from "@/cli/helpers/json-output";

/** How long `status` waits for `/health` before calling the daemon unreachable. */
const STATUS_PROBE_TIMEOUT_MS = 1_000;

/** Recent tick failures `status` prints; `--json` carries all the record keeps. */
const STATUS_ERRORS_SHOWN = 3;

/** How often `logs -f` looks for new output. */
const FOLLOW_POLL_INTERVAL_MS = 500;

/** Bytes read per step while finding the last lines of the log. */
const TAIL_CHUNK_BYTES = 64 * 1024;

export type DaemonState = "running" | "port-taken" | "stopped" | "crashed";

export interface DaemonStatusReport {
  readonly state: DaemonState;
  readonly host: string;
  readonly port: number;
  readonly pid?: number;
  readonly supervisor: "systemd" | "launchd" | "none";
  readonly record?: DaemonStatusRecord;
  readonly pending: {
    readonly reminders: number;
    readonly wakeTriggers: number;
    readonly jobBatches: number;
  };
  readonly logPath: string;
}

/**
 * The daemon's state from what answered on its port and what it last wrote. A record whose
 * process is gone, with nothing answering, is a daemon that died without stopping.
 */
export function decideDaemonState(input: {
  readonly owner: string | undefined;
  readonly thisHome: string;
  readonly record: DaemonStatusRecord | undefined;
  readonly recordProcessAlive: boolean;
}): DaemonState {
  if (input.owner !== undefined) {
    return input.owner === input.thisHome ? "running" : "port-taken";
  }
  if (input.record !== undefined && !input.recordProcessAlive) {
    return "crashed";
  }
  return "stopped";
}

function describeAge(atIso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(atIso)) / 1000));
  if (seconds < 120) {
    return `${String(seconds)}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  return minutes < 120 ? `${String(minutes)}m ago` : `${String(Math.round(minutes / 60))}h ago`;
}

export function formatDaemonStatus(report: DaemonStatusReport, now: number = Date.now()): string {
  const address = `http://${report.host}:${String(report.port)}`;
  const supervision =
    report.supervisor === "none"
      ? "not supervised: nothing restarts it after a reboot or crash (`sudo jazz daemon install`)"
      : `supervised by ${report.supervisor}`;
  const lines: string[] = [];
  switch (report.state) {
    case "running":
      lines.push(
        `jazz daemon is running on ${address}${report.pid !== undefined ? ` (pid ${String(report.pid)})` : ""}.`,
      );
      break;
    case "port-taken":
      lines.push(
        `Something else answers on ${address}: a daemon for another Jazz home, or from an older Jazz.`,
      );
      break;
    case "crashed":
      lines.push(
        `jazz daemon is not running. It last ran as pid ${String(report.record?.pid ?? 0)} and exited without stopping; see \`jazz daemon logs\`.`,
      );
      break;
    case "stopped":
      lines.push(`jazz daemon is not running on ${address}. Start it with \`jazz daemon\`.`);
      break;
  }
  lines.push(`  Service:   ${supervision}`);

  const record = report.record;
  if (record !== undefined && report.state !== "stopped") {
    lines.push(`  Started:   ${new Date(record.startedAt).toLocaleString()}`);
    if (record.servesPeers) {
      lines.push("  Peers:     served");
    }
    if (record.tickRunning && record.lastTickStartedAt !== undefined) {
      lines.push(`  Tick:      running since ${describeAge(record.lastTickStartedAt, now)}`);
    } else if (record.lastTickStartedAt !== undefined) {
      const took =
        record.lastTickDurationMs !== undefined
          ? `, took ${String(record.lastTickDurationMs)}ms`
          : "";
      lines.push(`  Last tick: ${describeAge(record.lastTickStartedAt, now)}${took}`);
    } else {
      lines.push("  Last tick: none yet");
    }
    lines.push(`  In flight: ${String(record.runsInFlight)} goal or loop run(s)`);
  }

  lines.push(
    `  Waiting:   ${String(report.pending.reminders)} reminder(s), ${String(report.pending.wakeTriggers)} wake trigger(s), ${String(report.pending.jobBatches)} job batch(es)`,
  );

  const errors = record?.recentErrors ?? [];
  if (errors.length > 0) {
    lines.push(`  Recent errors (${String(errors.length)}):`);
    for (const error of errors.slice(-STATUS_ERRORS_SHOWN)) {
      lines.push(`    ${new Date(error.at).toLocaleString()}  ${error.work}: ${error.message}`);
    }
  }
  lines.push(
    report.supervisor === "systemd"
      ? `  Logs:      journalctl -u ${SYSTEMD_SERVICE_NAME} (or \`jazz daemon logs\`)`
      : `  Logs:      ${report.logPath} (\`jazz daemon logs -f\`)`,
  );
  return lines.join("\n");
}

function currentSupervisor(): DaemonStatusReport["supervisor"] {
  if (!isDaemonSupervised()) {
    return "none";
  }
  const initSystem = detectInitSystem();
  return initSystem === "unsupported" ? "none" : initSystem;
}

export function daemonStatusCommand(options: {
  readonly host: string;
  readonly port: number;
  readonly json: boolean;
}) {
  return Effect.gen(function* () {
    const owner = yield* Effect.promise(() =>
      probeDaemonOwner(options.host, options.port, STATUS_PROBE_TIMEOUT_MS),
    );
    const record = yield* Effect.promise(() => readDaemonStatus(options.port));
    const pidFromFile = yield* Effect.promise(() => readDaemonPid(options.port));
    const state = decideDaemonState({
      owner,
      thisHome: getJazzInstanceId(),
      record,
      recordProcessAlive: record !== undefined && isProcessAlive(record.pid),
    });
    const pid = state === "running" ? (record?.pid ?? pidFromFile) : undefined;

    const countOf = <Item, Failure, Requirements>(
      collect: Effect.Effect<readonly Item[], Failure, Requirements>,
    ) =>
      collect.pipe(
        Effect.map((items) => items.length),
        Effect.catchAll(() => Effect.succeed(0)),
      );
    const report: DaemonStatusReport = {
      state,
      host: options.host,
      port: options.port,
      ...(pid !== undefined ? { pid } : {}),
      supervisor: currentSupervisor(),
      ...(record !== undefined ? { record } : {}),
      pending: {
        reminders: yield* countOf(collectReminders()),
        wakeTriggers: yield* countOf(collectTriggers()),
        jobBatches: yield* countOf(
          collectBatches().pipe(
            Effect.map((batches) => batches.filter((batch) => batch.completedAt === null)),
          ),
        ),
      },
      logPath: backgroundDaemonLogPath(),
    };

    const attention = yield* readDaemonAttention();
    emitEnvelope(
      options.json,
      { ok: true, running: state === "running", ...report, ...attention },
      `${formatDaemonStatus(report)}\n\n${formatDaemonAttention(attention)}`,
    );
    if (state !== "running") {
      process.exitCode = 1;
    }
  });
}

/** The last `count` lines of `filePath`, reading backwards from the end. */
export async function readLastLines(filePath: string, count: number): Promise<string[]> {
  const handle = await nodeFs.open(filePath, "r");
  try {
    const { size } = await handle.stat();
    let position = size;
    let buffered = Buffer.alloc(0);
    while (position > 0) {
      const length = Math.min(TAIL_CHUNK_BYTES, position);
      position -= length;
      const chunk = Buffer.alloc(length);
      await handle.read(chunk, 0, length, position);
      buffered = Buffer.concat([chunk, buffered]);
      let newlines = 0;
      for (const byte of buffered) {
        if (byte === 0x0a) {
          newlines++;
        }
      }
      if (newlines > count) {
        break;
      }
    }
    const lines = buffered.toString("utf-8").split("\n");
    if (lines.at(-1) === "") {
      lines.pop();
    }
    return lines.slice(-count);
  } finally {
    await handle.close();
  }
}

/**
 * Writes what is appended to `filePath` until interrupted. A file that shrinks was rotated or
 * truncated, so reading starts again from its beginning.
 */
function followFile(filePath: string, fromOffset: number): Effect.Effect<void> {
  return Effect.async<void>((resume) => {
    let offset = fromOffset;
    let reading = false;
    const poll = async (): Promise<void> => {
      if (reading) {
        return;
      }
      reading = true;
      try {
        const { size } = await nodeFs.stat(filePath);
        if (size < offset) {
          offset = 0;
        }
        if (size > offset) {
          const handle = await nodeFs.open(filePath, "r");
          try {
            const chunk = Buffer.alloc(size - offset);
            await handle.read(chunk, 0, chunk.length, offset);
            process.stdout.write(chunk);
            offset = size;
          } finally {
            await handle.close();
          }
        }
      } catch {
        offset = 0;
      } finally {
        reading = false;
      }
    };
    const timer = setInterval(() => void poll(), FOLLOW_POLL_INTERVAL_MS);
    const stop = (): void => {
      clearInterval(timer);
      resume(Effect.void);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return Effect.sync(() => {
      clearInterval(timer);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    });
  });
}

function journalLogs(lines: number, follow: boolean) {
  return Effect.promise(async () => {
    const child = Bun.spawn({
      cmd: [
        "journalctl",
        "-u",
        SYSTEMD_SERVICE_NAME,
        "-n",
        String(lines),
        "--no-pager",
        ...(follow ? ["-f"] : []),
      ],
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  });
}

export function daemonLogsCommand(options: { readonly follow: boolean; readonly lines: number }) {
  return Effect.gen(function* () {
    if (currentSupervisor() === "systemd") {
      yield* journalLogs(options.lines, options.follow);
      return;
    }
    const logPath = backgroundDaemonLogPath();
    if (!existsSync(logPath)) {
      process.stderr.write(
        `No daemon log yet at ${logPath}. A daemon started in the background or by launchd writes there.\n`,
      );
      if (!options.follow) {
        return;
      }
    } else {
      const lines = yield* Effect.promise(() => readLastLines(logPath, options.lines));
      if (lines.length > 0) {
        process.stdout.write(`${lines.join("\n")}\n`);
      }
    }
    if (options.follow) {
      const offset = yield* Effect.promise(() =>
        nodeFs.stat(logPath).then(
          (info) => info.size,
          () => 0,
        ),
      );
      yield* followFile(logPath, offset);
    }
  });
}
