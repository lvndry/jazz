/**
 * A private machine for one eval sample.
 *
 * Every path Jazz or its tools resolve from the environment points inside the sample: HOME
 * (skills and instructions under `~/.agents`, `~/.jazz`, OS scheduler folders), JAZZ_HOME,
 * TMPDIR (todos), XDG dirs, and PATH. PATH is closed: the sample's stub commands come first,
 * then Bun's own directory and the system directories, so a command-line tool installed for
 * the user (a mail client, a calendar CLI) cannot act on the user's real accounts. The OS
 * scheduler is replaced by the in-process one so reminders never install launchd or `at`
 * jobs, network commands are stubbed so a shell cannot reach past the web cassette, and the
 * timezone is UTC so times in prompts and oracles mean the same thing on every machine.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const STUB_IMPL = join(import.meta.dir, "stubs", "impl.ts");
const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/**
 * Commands every sample gets as logging stubs. The network ones fail as if offline; the OS
 * scheduler, package manager, and desktop notification ones succeed without touching the
 * machine, so a scenario can see an attempt (or a reminder being delivered) without it
 * having any effect.
 */
export const DEFAULT_STUBS = [
  "curl",
  "wget",
  "crontab",
  "launchctl",
  "brew",
  "at",
  "osascript",
  "notify-send",
] as const;

/** The user's real home, captured before any sample environment is applied. */
const REAL_HOME = homedir();
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * Binaries a sample must never run even by absolute path, which a closed PATH cannot stop:
 * the OS schedulers, desktop automation, privilege escalation, and anything installed by the
 * user outside the system directories.
 */
const FORBIDDEN_EXECUTABLES = [
  "/bin/launchctl",
  "/usr/bin/crontab",
  "/usr/bin/at",
  "/usr/bin/atq",
  "/usr/bin/osascript",
  "/usr/bin/open",
  "/usr/bin/sudo",
];
const FORBIDDEN_EXECUTABLE_TREES = ["/opt/homebrew", "/usr/local/bin", "/Applications"];

function osSandboxProfile(): string {
  const literals = FORBIDDEN_EXECUTABLES.map((path) => `(literal "${path}")`).join(" ");
  const trees = FORBIDDEN_EXECUTABLE_TREES.map((path) => `(subpath "${path}")`).join(" ");
  return `(version 1)(allow default)(deny process-exec ${literals} ${trees})(deny file-write* (subpath "${REAL_HOME}"))`;
}

/**
 * The argv to spawn a sample's jazz process under the OS sandbox on macOS: it may not execute
 * the binaries above by any path, and may not write anywhere in the user's real home. Samples
 * that carry the sandbox marker get it; elsewhere (no `sandbox-exec`) the argv is unchanged
 * and the PATH stubs are the only guard, which `osSandboxActive` reports.
 */
export function sandboxedArgv(
  argv: readonly string[],
  environment: Readonly<Record<string, string>> | undefined,
): string[] {
  if (environment?.["JAZZ_EVAL_OS_SANDBOX"] !== "1" || !osSandboxActive()) {
    return [...argv];
  }
  return [SANDBOX_EXEC, "-p", osSandboxProfile(), ...argv];
}

export function osSandboxActive(): boolean {
  return process.platform === "darwin" && existsSync(SANDBOX_EXEC);
}

export interface SampleSandbox {
  readonly root: string;
  readonly home: string;
  readonly jazzHome: string;
  readonly tmp: string;
  /** Stub commands' state (`data/`) and invocation log (`invocations.ndjson`). */
  readonly stubRoot: string;
  readonly environment: Readonly<Record<string, string>>;
}

export function createSandbox(label: string, stubs: readonly string[] = []): SampleSandbox {
  const root = mkdtempSync(join(tmpdir(), `eval-${label}-`));
  const home = join(root, "home");
  const jazzHome = join(home, ".jazz");
  const tmp = join(root, "tmp");
  const stubRoot = join(root, "stubs");
  const stubBin = join(stubRoot, "bin");
  for (const directory of [
    jazzHome,
    tmp,
    join(stubRoot, "data"),
    stubBin,
    join(home, ".config"),
    join(home, ".local", "share"),
  ]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  for (const command of new Set([...DEFAULT_STUBS, ...stubs])) {
    const shim = join(stubBin, command);
    writeFileSync(
      shim,
      `#!/bin/sh\nexec "${process.execPath}" "${STUB_IMPL}" "${stubRoot}" "${command}" "$@"\n`,
    );
    chmodSync(shim, 0o755);
  }
  return {
    root,
    home,
    jazzHome,
    tmp,
    stubRoot,
    environment: {
      HOME: home,
      JAZZ_HOME: jazzHome,
      TMPDIR: tmp,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      PATH: [stubBin, dirname(process.execPath), ...SYSTEM_PATH].join(":"),
      TZ: "UTC",
      JAZZ_EVAL_OS_SANDBOX: "1",
      JAZZ_SCHEDULER: "in-process",
      JAZZ_DISABLE_KEYRING: "1",
      CI: "1",
    },
  };
}

export function removeSandbox(sandbox: SampleSandbox): void {
  rmSync(sandbox.root, { recursive: true, force: true });
}
