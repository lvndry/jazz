/**
 * @fileoverview Handing the daemon's own foreground command line to a real supervisor.
 *
 * `jazz daemon` forks nothing and writes no pidfile on purpose — supervision is the host's
 * job (see `daemon.ts`'s own header). What jazz gave an operator to actually do that
 * supervision with, until now, was nothing: hand-write a systemd unit or launchd plist from
 * scratch, get the binary path, the env file, the permissions right, alone. This module is
 * that missing piece — it does not add process supervision jazz doesn't already refuse to
 * own, it just automates wiring the daemon into whichever supervisor the host already has.
 *
 * System-level units only (`/etc/systemd/system`, `/Library/LaunchDaemons`), never user-level
 * ones: the entire point is "survives reboot with nobody logged in," which a user unit only
 * gets via `loginctl enable-linger` gymnastics that defeat the purpose of automating this at
 * all. That means every write here needs root, checked once and refused with the exact
 * command to re-run rather than jazz ever invoking `sudo` itself — a CLI silently shelling
 * out to `sudo` is a trust boundary nobody asked it to cross; a human typing their own sudo
 * password at their own prompt is the same escalation, done honestly.
 *
 * The token never goes inside the unit/plist itself — those are otherwise-world-readable by
 * default. It lives in its own `chmod 600` file instead, sourced at process start.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import { execCommand } from "@jazz/core/utils/shell";
import { escapeShellArg, getLaunchdPath } from "@jazz/core/workflows/scheduler-service";
import { Effect } from "effect";
import * as plist from "plist";

export type InitSystem = "systemd" | "launchd" | "unsupported";

/**
 * `process.platform` plus a plain file-existence probe, matching every other platform check in
 * this codebase (`update-binary.ts`, `scheduler-service.ts`) — no abstraction layer, just the
 * inline check, since there is exactly one thing to decide.
 */
export function detectInitSystem(): InitSystem {
  if (process.platform === "darwin") return "launchd";
  if (process.platform === "linux") {
    return existsSync("/run/systemd/system") ? "systemd" : "unsupported";
  }
  return "unsupported";
}

const SYSTEMD_UNIT_PATH = "/etc/systemd/system/jazz-daemon.service";
const LAUNCHD_PLIST_PATH = "/Library/LaunchDaemons/com.jazz.daemon.plist";
const DAEMON_ENV_FILE_PATH = "/etc/jazz/daemon.env";
const DAEMON_ENV_FILE_MODE = 0o600;
const LAUNCHD_LABEL = "com.jazz.daemon";

/** The unit/plist path for whichever init system is actually present, or `undefined` if not. */
export function installedUnitPath(initSystem: InitSystem): string | undefined {
  if (initSystem === "systemd") return SYSTEMD_UNIT_PATH;
  if (initSystem === "launchd") return LAUNCHD_PLIST_PATH;
  return undefined;
}

/** Whether this host already has the unit/plist installed — the ambient prompt's guard. */
export function serviceAlreadyInstalled(initSystem: InitSystem): boolean {
  const unitPath = installedUnitPath(initSystem);
  return unitPath !== undefined && existsSync(unitPath);
}

export interface ServiceInstallOptions {
  readonly agentId: string;
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly invocation: readonly string[];
}

export function buildSystemdUnit(options: ServiceInstallOptions): string {
  const execStart = [
    ...options.invocation,
    "daemon",
    "--serve-peers",
    options.agentId,
    "--host",
    options.host,
    "--port",
    String(options.port),
  ]
    .map(escapeShellArg)
    .join(" ");

  return [
    "[Unit]",
    "Description=jazz daemon (peer-serving)",
    "After=network.target",
    "",
    "[Service]",
    "Type=simple",
    `EnvironmentFile=${DAEMON_ENV_FILE_PATH}`,
    `ExecStart=${execStart}`,
    "Restart=on-failure",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

export function buildLaunchdPlist(options: ServiceInstallOptions): string {
  const programArgs = [
    ...options.invocation,
    "daemon",
    "--serve-peers",
    options.agentId,
    "--host",
    options.host,
    "--port",
    String(options.port),
  ];
  // launchd has no `EnvironmentFile=` equivalent, so the token file is sourced by a small shell
  // wrapper before exec'ing the real command — the same "wrap in bash -c" idiom
  // `generateLaunchdPlist` already uses elsewhere in this codebase, just sourcing a secret
  // instead of printing a log header.
  const commandString = programArgs.map(escapeShellArg).join(" ");
  const wrappedArgs = [
    "/bin/bash",
    "-c",
    `set -a; source ${escapeShellArg(DAEMON_ENV_FILE_PATH)}; set +a; exec ${commandString}`,
  ];

  return plist.build({
    Label: LAUNCHD_LABEL,
    ProgramArguments: wrappedArgs,
    RunAtLoad: true,
    KeepAlive: true,
    EnvironmentVariables: { PATH: getLaunchdPath() },
  });
}

/**
 * True only if the human running this explicitly elevated (`sudo jazz daemon install ...`).
 * jazz never invokes `sudo` itself — see the file header for why.
 */
export function isRoot(): boolean {
  return process.getuid?.() === 0;
}

/** The exact command to re-run with `sudo`, reconstructed from what was actually typed. */
export function reRunWithSudoCommand(): string {
  return `sudo ${process.argv.slice(1).map(escapeShellArg).join(" ")}`;
}

export class ServiceInstallError extends Error {}

function requireRoot(): Effect.Effect<void, ServiceInstallError> {
  if (isRoot()) return Effect.void;
  return Effect.fail(
    new ServiceInstallError(
      `Installing a system service needs root. Run this again as:\n\n  ${reRunWithSudoCommand()}\n`,
    ),
  );
}

function writeEnvFile(token: string): Effect.Effect<void, ServiceInstallError> {
  return Effect.tryPromise({
    try: async () => {
      await nodeFs.mkdir(path.dirname(DAEMON_ENV_FILE_PATH), { recursive: true, mode: 0o755 });
      await nodeFs.writeFile(DAEMON_ENV_FILE_PATH, `JAZZ_DAEMON_TOKEN=${token}\n`, {
        mode: DAEMON_ENV_FILE_MODE,
      });
      // writeFile's `mode` only applies to a newly-created file — chmod again in case the
      // file already existed with a wider mode from a previous install.
      await nodeFs.chmod(DAEMON_ENV_FILE_PATH, DAEMON_ENV_FILE_MODE);
    },
    catch: (error) =>
      new ServiceInstallError(`Could not write ${DAEMON_ENV_FILE_PATH}: ${String(error)}`),
  });
}

export interface InstalledService {
  readonly initSystem: InitSystem;
  readonly unitPath: string;
}

/**
 * Write the unit/plist and env file, then reload and enable+start it for real — not a
 * dry-run that prints a script and leaves the rest to the operator. Idempotent: re-running
 * this regenerates and restarts rather than failing on "already exists".
 */
export function installService(
  options: ServiceInstallOptions,
): Effect.Effect<InstalledService, ServiceInstallError> {
  return Effect.gen(function* () {
    yield* requireRoot();

    const initSystem = detectInitSystem();
    if (initSystem === "unsupported") {
      return yield* Effect.fail(
        new ServiceInstallError(
          "No supported init system detected (systemd on Linux, launchd on macOS). " +
            "See docs/guide/peers-setup.md for a manual unit you can adapt.",
        ),
      );
    }

    yield* writeEnvFile(options.token);

    if (initSystem === "systemd") {
      yield* Effect.tryPromise({
        try: () => nodeFs.writeFile(SYSTEMD_UNIT_PATH, buildSystemdUnit(options), "utf-8"),
        catch: (error) =>
          new ServiceInstallError(`Could not write ${SYSTEMD_UNIT_PATH}: ${String(error)}`),
      });
      yield* execCommand("systemctl", ["daemon-reload"]).pipe(
        Effect.mapError((error) => new ServiceInstallError(error.message)),
      );
      yield* execCommand("systemctl", ["enable", "--now", "jazz-daemon"]).pipe(
        Effect.mapError((error) => new ServiceInstallError(error.message)),
      );
      return { initSystem, unitPath: SYSTEMD_UNIT_PATH };
    }

    yield* Effect.tryPromise({
      try: () => nodeFs.writeFile(LAUNCHD_PLIST_PATH, buildLaunchdPlist(options), "utf-8"),
      catch: (error) =>
        new ServiceInstallError(`Could not write ${LAUNCHD_PLIST_PATH}: ${String(error)}`),
    });
    // Unload first, ignoring failure — a re-install has nothing loaded yet the first time.
    yield* execCommand("launchctl", ["unload", LAUNCHD_PLIST_PATH]).pipe(
      Effect.catchAll(() => Effect.void),
    );
    yield* execCommand("launchctl", ["load", LAUNCHD_PLIST_PATH]).pipe(
      Effect.mapError((error) => new ServiceInstallError(error.message)),
    );
    return { initSystem, unitPath: LAUNCHD_PLIST_PATH };
  });
}

export function uninstallService(): Effect.Effect<void, ServiceInstallError> {
  return Effect.gen(function* () {
    yield* requireRoot();

    const initSystem = detectInitSystem();
    if (initSystem === "systemd") {
      yield* execCommand("systemctl", ["disable", "--now", "jazz-daemon"]).pipe(
        Effect.catchAll(() => Effect.void),
      );
      yield* Effect.tryPromise({
        try: () => nodeFs.rm(SYSTEMD_UNIT_PATH, { force: true }),
        catch: (error) => new ServiceInstallError(String(error)),
      });
      yield* execCommand("systemctl", ["daemon-reload"]).pipe(Effect.catchAll(() => Effect.void));
    } else if (initSystem === "launchd") {
      yield* execCommand("launchctl", ["unload", LAUNCHD_PLIST_PATH]).pipe(
        Effect.catchAll(() => Effect.void),
      );
      yield* Effect.tryPromise({
        try: () => nodeFs.rm(LAUNCHD_PLIST_PATH, { force: true }),
        catch: (error) => new ServiceInstallError(String(error)),
      });
    }

    yield* Effect.tryPromise({
      try: () => nodeFs.rm(DAEMON_ENV_FILE_PATH, { force: true }),
      catch: (error) => new ServiceInstallError(String(error)),
    });
  });
}

/** A fresh random token for the env file — this path never touches the keyring at all. */
export function generateDaemonToken(): string {
  return randomBytes(24).toString("hex");
}
