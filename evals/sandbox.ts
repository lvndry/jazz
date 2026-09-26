/**
 * A private machine for one eval sample.
 *
 * Every path Jazz or its tools resolve from the environment points inside the sample: HOME
 * (skills and instructions under `~/.agents`, `~/.jazz`, OS scheduler folders), JAZZ_HOME,
 * TMPDIR (todos), XDG dirs, and PATH. PATH is closed: the sample's stub commands come first,
 * then Bun's own directory and the system directories, so a command-line tool installed for
 * the user (a mail client, a calendar CLI) cannot act on the user's real accounts. The OS
 * scheduler is replaced by the in-process one so reminders never install launchd or `at`
 * jobs, and network commands are stubbed so a shell cannot reach past the web cassette.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const STUB_IMPL = join(import.meta.dir, "stubs", "impl.ts");
const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/**
 * Commands every sample gets as logging stubs. The network ones fail as if offline; the OS
 * scheduler and package manager ones succeed without touching the machine, so a scenario can
 * see an attempt without it having any effect.
 */
export const DEFAULT_STUBS = ["curl", "wget", "crontab", "launchctl", "brew", "at"] as const;

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
      JAZZ_SCHEDULER: "in-process",
      JAZZ_DISABLE_KEYRING: "1",
      CI: "1",
    },
  };
}

export function removeSandbox(sandbox: SampleSandbox): void {
  rmSync(sandbox.root, { recursive: true, force: true });
}
