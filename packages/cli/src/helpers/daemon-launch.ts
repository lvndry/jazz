/**
 * Starting the local daemon in the background, apart from the daemon command itself so chat's
 * `/goal` and `/loop` and the `goal`/`loop` commands can launch one without loading its server.
 */

import * as nodeFs from "node:fs";
import * as path from "node:path";
import { DEFAULT_DAEMON_HOST, DEFAULT_DAEMON_PORT } from "@jazz/core/constants/daemon";
import { getJazzInstanceId } from "@jazz/core/utils/instance-id";
import { getJazzHomeDirectory } from "@jazz/core/utils/paths";
import { getJazzSchedulerInvocation } from "@jazz/core/utils/runtime";
import { daemonLogPath, isDaemonSupervised } from "@jazz/daemon/service-install";
import { Effect } from "effect";
import { probeDaemonOwner, waitForDaemonHealth, writeDaemonPid } from "./daemon-process";

/** Where a background daemon listens, and the agent it serves peers with when it does. */
export interface BackgroundDaemonOptions {
  readonly host: string;
  readonly port: number;
  readonly peerAgent?: string | undefined;
}

/** The background daemon's log, `$JAZZ_HOME/logs/daemon.log`. */
export function backgroundDaemonLogPath(): string {
  return daemonLogPath(getJazzHomeDirectory());
}

/**
 * Opens the daemon log for appending, private to the owner. The child inherits the
 * descriptor; append mode keeps its writes at the end after the log sweep truncates it.
 */
function openDaemonLog(): number {
  const logPath = backgroundDaemonLogPath();
  nodeFs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
  return nodeFs.openSync(logPath, "a", 0o600);
}

export type BackgroundStart =
  { readonly kind: "started"; readonly pid: number } | { readonly kind: "unhealthy" };

/**
 * How the background daemon is spawned: in a session of its own (`detached`), which has no
 * controlling terminal, so the daemon outlives the terminal that started it and never writes
 * terminal notifications into it. Output goes to the daemon log.
 */
export function backgroundDaemonSpawnOptions(
  cmd: readonly string[],
  logDescriptor: number,
): Bun.SpawnOptions.OptionsObject<"ignore", number, number> & { cmd: string[] } {
  return {
    cmd: [...cmd],
    stdout: logDescriptor,
    stderr: logDescriptor,
    stdin: "ignore",
    env: process.env,
    detached: true,
  };
}

/** Re-exec this CLI with `--foreground`, detached, and wait until `/health` answers. */
export function spawnBackgroundDaemon(options: BackgroundDaemonOptions) {
  return Effect.gen(function* () {
    const invocation = yield* getJazzSchedulerInvocation();
    const args = [
      ...invocation,
      "daemon",
      "--foreground",
      "--port",
      String(options.port),
      "--host",
      options.host,
      ...(options.peerAgent !== undefined ? ["--serve-peers", options.peerAgent] : []),
    ];

    const logDescriptor = yield* Effect.sync(() => openDaemonLog());
    const child = Bun.spawn(backgroundDaemonSpawnOptions(args, logDescriptor));
    nodeFs.closeSync(logDescriptor);
    child.unref();

    const healthy = yield* Effect.promise(() => waitForDaemonHealth(options.host, options.port));
    if (!healthy) {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {
        // already gone
      }
      const unhealthy: BackgroundStart = { kind: "unhealthy" };
      return unhealthy;
    }
    yield* Effect.promise(() => writeDaemonPid(options.port, child.pid));
    const started: BackgroundStart = { kind: "started", pid: child.pid };
    return started;
  });
}

/** How long `ensureDaemonRunning` waits on a daemon that may already be serving. */
const RUNNING_DAEMON_PROBE_MS = 1_000;

export type DaemonAvailability =
  | { readonly kind: "running" }
  | { readonly kind: "started"; readonly pid: number }
  /** Something else holds the daemon port: a daemon for another Jazz home, or an older one. */
  | { readonly kind: "port-taken"; readonly port: number }
  | { readonly kind: "unavailable" };

/**
 * Make sure the local daemon is serving, starting one in the background when none answers,
 * so starting a goal or loop starts its work instead of leaving it waiting for `jazz daemon`.
 */
export function ensureDaemonRunning() {
  return Effect.gen(function* () {
    const options = { host: DEFAULT_DAEMON_HOST, port: DEFAULT_DAEMON_PORT };
    const owner = yield* Effect.promise(() =>
      probeDaemonOwner(options.host, options.port, RUNNING_DAEMON_PROBE_MS),
    );
    if (owner !== undefined) {
      const found: DaemonAvailability =
        owner === getJazzInstanceId()
          ? { kind: "running" }
          : { kind: "port-taken", port: options.port };
      return found;
    }
    const started = yield* spawnBackgroundDaemon(options);
    if (started.kind !== "started") {
      const unavailable: DaemonAvailability = { kind: "unavailable" };
      return unavailable;
    }
    const answering = yield* Effect.promise(() =>
      probeDaemonOwner(options.host, options.port, RUNNING_DAEMON_PROBE_MS),
    );
    const availability: DaemonAvailability =
      answering === getJazzInstanceId() ? started : { kind: "port-taken", port: options.port };
    return availability;
  });
}

/**
 * The warning for a daemon no supervisor restarts, or undefined when one does. Background work
 * waits in such a daemon until it is started again after a reboot or crash.
 */
export function unsupervisedDaemonNote(supervised: boolean): string | undefined {
  return supervised
    ? undefined
    : "No supervised daemon is installed, so nothing restarts the daemon after a reboot or a " +
        "crash, and background work waits until `jazz daemon` runs again. Run " +
        "`sudo jazz daemon install` to keep it running.";
}

/**
 * What starting a goal or loop did, given whether a daemon is now working on it, and a
 * warning when that daemon is not supervised. `subject` names it, like `Goal detach-to-prod`.
 */
export function describeDaemonStart(
  subject: string,
  daemon: DaemonAvailability,
  supervised: boolean = isDaemonSupervised(),
): string {
  const note = unsupervisedDaemonNote(supervised);
  const withNote = (sentence: string): string =>
    note === undefined ? sentence : `${sentence}\n${note}`;
  switch (daemon.kind) {
    case "running":
      return withNote(`${subject} started; the daemon is working on it.`);
    case "started":
      return withNote(
        `${subject} started; launched the daemon in the background (pid ${String(daemon.pid)}) to work on it.`,
      );
    case "port-taken":
      return `${subject} is saved, but the daemon on port ${String(daemon.port)} is not serving this Jazz home (another home, or a daemon from an older Jazz); restart it with \`jazz daemon stop\` then \`jazz daemon\`, or run one for this home on another port.`;
    case "unavailable":
      return withNote(
        `${subject} is saved, but the daemon could not be started; run \`jazz daemon\` to begin the work.`,
      );
  }
}
