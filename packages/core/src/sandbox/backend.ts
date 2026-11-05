/**
 * @fileoverview Which write-confinement backend this machine has, and how much of the promise
 * it keeps, found by running it once.
 *
 * `probeConfinement` launches a real command under each candidate backend: one write inside a
 * probe root that must succeed, one write beside it that must be denied. Enforcement is a
 * measured fact reported as a level, never assumed from a binary's presence:
 *
 * - `full`: writes outside the roots were denied and writes inside succeeded.
 * - `partial`: confinement holds, with a named gap (Linux hosts whose kernel refuses a private
 *   `/dev` fall back to the host's, so device nodes stay writable).
 * - `none`: no backend, or one that did not deny the outside write.
 *
 * `getConfinementStatus` runs the probe once per process and caches the answer. The probe runs
 * through an injected `ProbeRunner`, so the interpretation of results is unit-tested without a
 * sandbox on the machine.
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type BwrapDeviceMode, SANDBOX_EXEC_PATH, bwrapArgv, seatbeltArgv } from "./launchers";
import { canonicalizePath } from "./write-policy";

export type ConfinementLevel = "full" | "partial" | "none";
export type ConfinementBackend = "seatbelt" | "bwrap" | "none";

export interface ConfinementStatus {
  readonly level: ConfinementLevel;
  readonly backend: ConfinementBackend;
  /** Set for `bwrap`: the absolute path the probe succeeded with. */
  readonly bwrapPath?: string;
  readonly devices?: BwrapDeviceMode;
  /** Why confinement is partial or unavailable. */
  readonly reason?: string;
  /** What to do about it, worded for the person reading the refusal. */
  readonly remedy?: string;
}

export interface ProbeResult {
  readonly status: number | null;
  readonly stderr: string;
  readonly spawnError?: string;
}

export type ProbeRunner = (argv: readonly string[]) => ProbeResult;

/** Wall-clock cap on one probe launch, which only runs `sh` and two `echo`s. */
export const PROBE_TIMEOUT_MS = 5_000;

/** Exit codes the probe script uses; any other status is a launcher failure. */
const PROBE_INSIDE_WRITE_FAILED = 10;
const PROBE_OUTSIDE_WRITE_ALLOWED = 11;

const PROBE_SCRIPT = `echo probe > "$1/inside" || exit ${String(PROBE_INSIDE_WRITE_FAILED)}
echo probe > "$2/outside" 2>/dev/null && exit ${String(PROBE_OUTSIDE_WRITE_ALLOWED)}
exit 0`;

const MACOS_REMEDY =
  "Run Jazz on a host where /usr/bin/sandbox-exec works, or set `shell.confinement` to `off` in ~/.jazz/config.json to run commands unconfined.";
const LINUX_REMEDY =
  "Install bubblewrap (`apt install bubblewrap`, `dnf install bubblewrap`, `apk add bubblewrap`) and allow unprivileged user namespaces, or set `shell.confinement` to `off` in ~/.jazz/config.json to run commands unconfined.";
const UNSUPPORTED_REMEDY =
  "Write confinement supports macOS and Linux. Set `shell.confinement` to `off` in the Jazz config to run commands unconfined, or run Jazz inside WSL.";

function defaultProbeRunner(argv: readonly string[]): ProbeResult {
  const [command, ...args] = argv;
  if (command === undefined) {
    return { status: null, stderr: "", spawnError: "empty argv" };
  }
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,
    stdio: ["ignore", "ignore", "pipe"],
  });
  return {
    status: result.status,
    stderr: result.stderr ?? "",
    ...(result.error !== undefined ? { spawnError: result.error.message } : {}),
  };
}

/**
 * Where `bwrap` is looked for: fixed absolute paths owned by the system, never `PATH`. A
 * project-writable `PATH` entry such as `node_modules/.bin` could otherwise supply a launcher
 * that exits 0 without confining anything.
 */
export const TRUSTED_BWRAP_PATHS: readonly string[] = [
  "/usr/bin/bwrap",
  "/bin/bwrap",
  "/usr/local/bin/bwrap",
  "/run/current-system/sw/bin/bwrap",
];

function firstExecutable(candidates: readonly string[]): string | undefined {
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

type ProbeVerdict =
  { readonly confined: true } | { readonly confined: false; readonly reason: string };

/** Reads a probe launch: confined only when the inside write worked and the outside write was refused. */
export function interpretProbe(
  result: ProbeResult,
  landed: { readonly inside: boolean; readonly outside: boolean },
): ProbeVerdict {
  if (result.spawnError !== undefined) {
    return { confined: false, reason: `the backend could not start (${result.spawnError})` };
  }
  if (result.status === 0 && landed.inside && !landed.outside) {
    return { confined: true };
  }
  if (result.status === 0 && !landed.inside && !landed.outside) {
    return {
      confined: false,
      reason: "the backend reported success without running the probe command",
    };
  }
  if (result.status === PROBE_OUTSIDE_WRITE_ALLOWED || landed.outside) {
    return {
      confined: false,
      reason: "the backend started but did not deny a write outside its roots",
    };
  }
  if (result.status === PROBE_INSIDE_WRITE_FAILED) {
    return { confined: false, reason: "the backend denied a write inside its own writable root" };
  }
  const detail = result.stderr.trim().split("\n")[0] ?? "";
  return {
    confined: false,
    reason: `the backend exited with status ${String(result.status)}${detail.length > 0 ? `: ${detail}` : ""}`,
  };
}

interface ProbeFixture {
  readonly insideRoot: string;
  readonly outsideDirectory: string;
  dispose(): void;
}

function createProbeFixture(): ProbeFixture {
  const base = mkdtempSync(path.join(os.tmpdir(), "jazz-confinement-probe-"));
  const insideRoot = canonicalizePath(path.join(base, "inside"));
  const outsideDirectory = canonicalizePath(path.join(base, "outside"));
  return {
    insideRoot,
    outsideDirectory,
    dispose: () => rmSync(base, { recursive: true, force: true }),
  };
}

function probeBackend(
  wrap: (insideRoot: string, command: readonly string[]) => readonly string[],
  runner: ProbeRunner,
): ProbeVerdict {
  const fixture = createProbeFixture();
  try {
    for (const directory of [fixture.insideRoot, fixture.outsideDirectory]) {
      mkdirSync(directory, { recursive: true });
    }
    const result = runner(
      wrap(fixture.insideRoot, [
        "sh",
        "-c",
        PROBE_SCRIPT,
        "probe",
        fixture.insideRoot,
        fixture.outsideDirectory,
      ]),
    );
    return interpretProbe(result, {
      inside: existsSync(path.join(fixture.insideRoot, "inside")),
      outside: existsSync(path.join(fixture.outsideDirectory, "outside")),
    });
  } finally {
    fixture.dispose();
  }
}

export interface ProbeEnvironment {
  readonly platform: NodeJS.Platform;
  /** Where `bwrap` may be found; defaults to the fixed system locations. */
  readonly bwrapCandidates?: readonly string[];
  readonly runner?: ProbeRunner;
  readonly sandboxExecExists?: boolean;
}

/** Runs the backend this platform offers against a throwaway directory pair and reports what held. */
export function probeConfinement(environment: ProbeEnvironment): ConfinementStatus {
  const runner = environment.runner ?? defaultProbeRunner;
  if (environment.platform === "darwin") {
    const exists = environment.sandboxExecExists ?? existsSync(SANDBOX_EXEC_PATH);
    if (!exists) {
      return {
        level: "none",
        backend: "none",
        reason: `${SANDBOX_EXEC_PATH} is not present`,
        remedy: MACOS_REMEDY,
      };
    }
    const verdict = probeBackend(
      (insideRoot, command) => seatbeltArgv({ roots: [insideRoot] }, command),
      runner,
    );
    return verdict.confined
      ? { level: "full", backend: "seatbelt" }
      : { level: "none", backend: "none", reason: verdict.reason, remedy: MACOS_REMEDY };
  }
  if (environment.platform === "linux") {
    const bwrapPath = firstExecutable(environment.bwrapCandidates ?? TRUSTED_BWRAP_PATHS);
    if (bwrapPath === undefined) {
      return {
        level: "none",
        backend: "none",
        reason: "bubblewrap (`bwrap`) is not installed",
        remedy: LINUX_REMEDY,
      };
    }
    const devices: readonly BwrapDeviceMode[] = ["minimal", "host"];
    let lastReason = "";
    for (const mode of devices) {
      const verdict = probeBackend(
        (insideRoot, command) => bwrapArgv(bwrapPath, { roots: [insideRoot] }, command, mode),
        runner,
      );
      if (verdict.confined) {
        return mode === "minimal"
          ? { level: "full", backend: "bwrap", bwrapPath, devices: mode }
          : {
              level: "partial",
              backend: "bwrap",
              bwrapPath,
              devices: mode,
              reason:
                "this kernel refused a private /dev, so device nodes under /dev stay writable",
            };
      }
      lastReason = verdict.reason;
    }
    return {
      level: "none",
      backend: "none",
      reason: `bubblewrap is installed but unusable here (${lastReason})`,
      remedy: LINUX_REMEDY,
    };
  }
  return {
    level: "none",
    backend: "none",
    reason: `${environment.platform} has no supported write-confinement backend`,
    remedy: UNSUPPORTED_REMEDY,
  };
}

let cachedStatus: ConfinementStatus | undefined;

/** The process's confinement status, probed on first use and cached for the rest of the run. */
export function getConfinementStatus(): ConfinementStatus {
  cachedStatus ??= probeConfinement({ platform: process.platform });
  return cachedStatus;
}

/** Drops the cached probe; for tests that change the environment the probe reads. */
export function resetConfinementStatusCache(): void {
  cachedStatus = undefined;
}
