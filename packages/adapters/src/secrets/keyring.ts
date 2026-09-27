import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { writeFileDurably } from "@jazz/core/utils/durable-file";
import { withFileLock } from "@jazz/core/utils/file-lock";
import { isRecord } from "@jazz/core/utils/is-record";
import {
  getJazzHomeDirectory,
  getSecretsFilePath,
  getSecretsLockPath,
} from "@jazz/core/utils/paths";
import { quarantineCorruptFile } from "@jazz/core/utils/storage";
import { Effect } from "effect";
import { KEYRING_SERVICE_NAME } from "./registry";

/**
 * Which secret store `keyringGet`/`keyringSet`/`keyringDelete` use.
 *
 * - `"macos"` — Keychain, via the `security` CLI.
 * - `"libsecret"` — the Linux Secret Service, via the `secret-tool` CLI (gnome-keyring or
 *   similar).
 * - `"file"` — a `chmod 600` JSON file under `$JAZZ_HOME`, used when neither OS keyring is
 *   reachable (typically a headless server with no D-Bus session).
 * - `"none"` — nothing stored; reads return nothing, writes are refused. Only reachable via
 *   the `$JAZZ_DISABLE_KEYRING` opt-out, since `"file"` covers every other case.
 *
 * `security`/`secret-tool` over a native keyring binding: jazz ships a slim install, and every
 * native binding drags prebuilt binaries per platform behind it. Both CLIs already ship with
 * their platform, so shelling out keeps the dependency footprint at zero.
 */
export type KeyringBackend = "macos" | "libsecret" | "file" | "none";

/** Human-readable name for a backend, for success/status messages. */
export function describeKeyringBackend(backend: KeyringBackend): string {
  switch (backend) {
    case "macos":
      return "the macOS keychain";
    case "libsecret":
      return "the Linux keyring";
    case "file":
      return "$JAZZ_HOME/secrets.json";
    case "none":
      return "nowhere";
  }
}

const PROBE_ACCOUNT = "__jazz_probe__";
const COMMAND_TIMEOUT_MS = 5_000;

/** Hex characters of the home-path SHA-256 kept in the service name: 64 bits, ample to tell homes apart. */
const HOME_SCOPE_HASH_LENGTH = 16;

/**
 * Upper bound on entries moved by one legacy migration pass. Each move deletes the legacy entry, so
 * the loop ends when none are left; the bound only stops a keyring that keeps returning an entry it
 * refuses to delete from spinning forever.
 */
const MAX_LEGACY_ENTRIES_MIGRATED = 1_000;

/**
 * The OS-keyring service holding one Jazz home's secrets: `jazz.<hash of the resolved home path>`.
 *
 * The OS keyring is shared by every Jazz home the user runs (`JAZZ_HOME`, `--data-dir`, test
 * homes), so account names alone would let one home read another's keys. Scoping the service name
 * keeps the registry's account names (`llm.openai.api_key`) unchanged and leaves every entry from
 * before scoping under the bare `jazz` service, where `migrateLegacyKeyringEntries` finds them.
 * The `"file"` backend needs no scope: `secrets.json` already lives inside the home.
 */
export function keyringServiceName(home: string = getJazzHomeDirectory()): string {
  const digest = createHash("sha256")
    .update(path.resolve(home))
    .digest("hex")
    .slice(0, HOME_SCOPE_HASH_LENGTH);
  return `${KEYRING_SERVICE_NAME}.${digest}`;
}

/** Whether the active home is the default `~/.jazz`, the only home that adopts legacy entries. */
function isDefaultJazzHome(): boolean {
  const userHome = os.homedir();
  if (!userHome) {
    return false;
  }
  return path.resolve(getJazzHomeDirectory()) === path.resolve(userHome, ".jazz");
}

export interface CommandResult {
  readonly ok: boolean;
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** True when the binary itself is missing or the call never completed. */
  readonly unavailable: boolean;
}

/** Runs a keyring CLI. Injected into the legacy migration so tests can stand in for the keyring. */
export type KeyringCommandRunner = (
  command: string,
  args: readonly string[],
  stdin?: string,
) => Effect.Effect<CommandResult, never>;

function runCommand(
  command: string,
  args: readonly string[],
  stdin?: string,
): Effect.Effect<CommandResult, never> {
  return Effect.async<CommandResult, never>((resume) => {
    let settled = false;
    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      resume(Effect.succeed(result));
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      finish({ ok: false, code: null, stdout: "", stderr: "", unavailable: true });
      return;
    }

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, code: null, stdout: "", stderr: "", unavailable: true });
    }, COMMAND_TIMEOUT_MS);

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", () => {
      clearTimeout(timer);
      finish({ ok: false, code: null, stdout: "", stderr: "", unavailable: true });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      finish({
        ok: code === 0,
        code,
        stdout,
        stderr,
        unavailable: false,
      });
    });

    if (stdin !== undefined) {
      child.stdin?.end(stdin);
    } else {
      child.stdin?.end();
    }

    return Effect.sync(() => {
      clearTimeout(timer);
      child.kill("SIGKILL");
    });
  });
}

function keyringDisabledByEnv(): boolean {
  const raw = process.env["JAZZ_DISABLE_KEYRING"];
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false";
}

/**
 * Determine which keyring backend is usable right now.
 *
 * On Linux this probes an actual lookup: `secret-tool` is frequently installed
 * on machines with no session D-Bus (headless servers), where every call fails.
 * Neither OS probe succeeding falls through to `"file"` rather than `"none"` — see the
 * `KeyringBackend` doc comment for why that fallback is safe to take automatically instead
 * of asking the operator to choose it.
 */
export function detectKeyringBackend(): Effect.Effect<KeyringBackend, never> {
  return Effect.gen(function* () {
    if (keyringDisabledByEnv()) return "none" as const;

    if (process.platform === "darwin") {
      const probe = yield* runCommand("security", [
        "find-generic-password",
        "-s",
        KEYRING_SERVICE_NAME,
        "-a",
        PROBE_ACCOUNT,
      ]);
      if (!probe.unavailable) return "macos" as const;
    } else if (process.platform === "linux") {
      const probe = yield* runCommand("secret-tool", [
        "lookup",
        "service",
        KEYRING_SERVICE_NAME,
        "account",
        PROBE_ACCOUNT,
      ]);
      // A clean "not found" exits non-zero with no diagnostics; a broken or
      // absent secret service always explains itself on stderr.
      if (!probe.unavailable && probe.stderr.trim() === "") return "libsecret" as const;
    }

    return "file" as const;
  });
}

const SECRETS_FILE_MODE = 0o600;
function secretsFilePath(): string {
  return getSecretsFilePath();
}

function withSecretsFileLock<T>(operation: () => Promise<T>): Promise<T> {
  return withFileLock(getSecretsLockPath(), operation);
}

type SecretsFileRead =
  | { readonly status: "ok"; readonly secrets: Record<string, string> }
  | { readonly status: "corrupt"; readonly reason: string }
  | { readonly status: "unreadable"; readonly error: Error };

async function readSecretsFileContent(): Promise<SecretsFileRead> {
  let raw: string;
  try {
    raw = await nodeFs.readFile(secretsFilePath(), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "ok", secrets: {} };
    }
    return { status: "unreadable", error: error as Error };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed)
      ? { status: "ok", secrets: parsed as Record<string, string> }
      : { status: "corrupt", reason: "expected an object" };
  } catch (error) {
    return { status: "corrupt", reason: (error as Error).message };
  }
}

/** For lookups: a missing, unreadable, or corrupt file reads as "nothing stored". */
function readSecretsFile(): Effect.Effect<Record<string, string>, never> {
  return Effect.promise(async () => {
    const read = await readSecretsFileContent();
    return read.status === "ok" ? read.secrets : {};
  });
}

/**
 * For a read-modify-write under `.secrets.lock`: a corrupt file is moved aside before the write
 * replaces it, so the secrets it held stay recoverable instead of being overwritten.
 */
async function readSecretsFileForWrite(): Promise<Record<string, string>> {
  const read = await readSecretsFileContent();
  if (read.status === "ok") {
    return read.secrets;
  }
  if (read.status === "unreadable") {
    throw read.error;
  }
  await Effect.runPromise(quarantineCorruptFile(secretsFilePath(), read.reason));
  return {};
}

/**
 * Replace `secrets.json` durably (temp file, fsync, rename) with mode 0600. Callers performing
 * read-modify-write hold `.secrets.lock`, preventing concurrent provider/plugin secret updates
 * from silently losing one another.
 */
async function writeSecretsFile(secrets: Record<string, string>): Promise<boolean> {
  try {
    await writeFileDurably(secretsFilePath(), `${JSON.stringify(secrets, null, 2)}\n`, {
      mode: SECRETS_FILE_MODE,
    });
    return true;
  } catch {
    return false;
  }
}

type OsKeyringBackend = "macos" | "libsecret";

function osKeyringGet(
  run: KeyringCommandRunner,
  backend: OsKeyringBackend,
  service: string,
  account: string,
): Effect.Effect<string | undefined, never> {
  return Effect.gen(function* () {
    const result =
      backend === "macos"
        ? yield* run("security", ["find-generic-password", "-w", "-s", service, "-a", account])
        : yield* run("secret-tool", ["lookup", "service", service, "account", account]);
    if (!result.ok) {
      return undefined;
    }
    const value = result.stdout.replace(/\n$/, "");
    return value === "" ? undefined : value;
  });
}

function osKeyringSet(
  run: KeyringCommandRunner,
  backend: OsKeyringBackend,
  service: string,
  account: string,
  secret: string,
): Effect.Effect<boolean, never> {
  return Effect.gen(function* () {
    if (backend === "macos") {
      // `security` has no stdin mode for writes, so the value is briefly visible
      // in this process's argv. Accepted: macOS Keychain is a single-user
      // desktop path, and the multi-user exposure this guards against is Linux.
      const result = yield* run("security", [
        "add-generic-password",
        "-U",
        "-s",
        service,
        "-a",
        account,
        "-w",
        secret,
      ]);
      return result.ok;
    }
    const result = yield* run(
      "secret-tool",
      ["store", "--label", `jazz: ${account}`, "service", service, "account", account],
      secret,
    );
    return result.ok;
  });
}

function osKeyringDelete(
  run: KeyringCommandRunner,
  backend: OsKeyringBackend,
  service: string,
  account: string,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    if (backend === "macos") {
      yield* run("security", ["delete-generic-password", "-s", service, "-a", account]);
      return;
    }
    yield* run("secret-tool", ["clear", "service", service, "account", account]);
  });
}

/**
 * The account of any one entry under `service`, or undefined when there is none.
 *
 * `security find-generic-password -s` prints the first match's attributes, with the account as
 * `"acct"<blob>="name"` (or `=0x<hex>  "..."` when the name is not plain ASCII). `secret-tool search`
 * prints `attribute.account = name`.
 */
function osKeyringAnyAccount(
  run: KeyringCommandRunner,
  backend: OsKeyringBackend,
  service: string,
): Effect.Effect<string | undefined, never> {
  return Effect.gen(function* () {
    if (backend === "macos") {
      const result = yield* run("security", ["find-generic-password", "-s", service]);
      if (!result.ok) {
        return undefined;
      }
      const hexMatch = /^\s*"acct"<blob>=0x([0-9A-Fa-f]+)/m.exec(result.stdout);
      if (hexMatch?.[1] !== undefined) {
        return Buffer.from(hexMatch[1], "hex").toString("utf8");
      }
      return /^\s*"acct"<blob>="(.*)"\s*$/m.exec(result.stdout)?.[1];
    }
    const result = yield* run("secret-tool", ["search", "service", service]);
    if (!result.ok) {
      return undefined;
    }
    return /^attribute\.account = (.*)$/m.exec(`${result.stdout}\n${result.stderr}`)?.[1];
  });
}

/**
 * Move every entry under the bare `jazz` service, which every Jazz home shared before scoping,
 * into `targetService`, deleting each legacy entry once it has a scoped copy.
 *
 * An entry already present under `targetService` wins over the legacy one. The pass stops at the
 * first entry it cannot read or store, leaving that entry and the rest in place for the next
 * process to retry. Returns the accounts moved.
 */
export function migrateLegacyKeyringEntries(
  backend: OsKeyringBackend,
  targetService: string,
  run: KeyringCommandRunner = runCommand,
): Effect.Effect<readonly string[], never> {
  return Effect.gen(function* () {
    const moved: string[] = [];
    for (let attempt = 0; attempt < MAX_LEGACY_ENTRIES_MIGRATED; attempt++) {
      const account = yield* osKeyringAnyAccount(run, backend, KEYRING_SERVICE_NAME);
      if (account === undefined) {
        break;
      }
      const legacyValue = yield* osKeyringGet(run, backend, KEYRING_SERVICE_NAME, account);
      if (legacyValue === undefined) {
        break;
      }
      const scopedValue = yield* osKeyringGet(run, backend, targetService, account);
      if (scopedValue === undefined) {
        const stored = yield* osKeyringSet(run, backend, targetService, account, legacyValue);
        if (!stored) {
          break;
        }
      }
      yield* osKeyringDelete(run, backend, KEYRING_SERVICE_NAME, account);
      moved.push(account);
    }
    return moved;
  });
}

const legacyMigrations = new Map<string, Promise<readonly string[]>>();

/**
 * Adopt legacy entries into the default home's service, once per process.
 *
 * Only `~/.jazz` adopts them: it is the home those keys were almost always written from, and a
 * throwaway `JAZZ_HOME` must never claim, and then lose with its directory, the user's real keys.
 * Any other home starts with an empty keyring scope.
 */
function adoptLegacyEntries(backend: OsKeyringBackend): Effect.Effect<void, never> {
  if (!isDefaultJazzHome()) {
    return Effect.void;
  }
  const service = keyringServiceName();
  const key = `${backend}:${service}`;
  return Effect.promise(() => {
    let pending = legacyMigrations.get(key);
    if (pending === undefined) {
      pending = Effect.runPromise(migrateLegacyKeyringEntries(backend, service));
      legacyMigrations.set(key, pending);
    }
    return pending;
  }).pipe(Effect.asVoid);
}

/** Read a secret. Returns undefined when absent or unreadable. */
export function keyringGet(
  backend: KeyringBackend,
  account: string,
): Effect.Effect<string | undefined, never> {
  return Effect.gen(function* () {
    if (backend === "none") return undefined;
    if (backend === "file") {
      const secrets = yield* readSecretsFile();
      return secrets[account];
    }
    yield* adoptLegacyEntries(backend);
    return yield* osKeyringGet(runCommand, backend, keyringServiceName(), account);
  });
}

/** Store a secret. Returns false when the keyring refused the write. */
export function keyringSet(
  backend: KeyringBackend,
  account: string,
  secret: string,
): Effect.Effect<boolean, never> {
  return Effect.gen(function* () {
    if (backend === "none") return false;
    if (backend === "file") {
      return yield* Effect.promise(() =>
        withSecretsFileLock(async () => {
          const secrets = await readSecretsFileForWrite();
          return writeSecretsFile({ ...secrets, [account]: secret });
        }),
      ).pipe(Effect.catchAll(() => Effect.succeed(false)));
    }
    yield* adoptLegacyEntries(backend);
    return yield* osKeyringSet(runCommand, backend, keyringServiceName(), account, secret);
  });
}

/** Remove a secret. Missing entries are not an error. */
export function keyringDelete(
  backend: KeyringBackend,
  account: string,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    if (backend === "none") return;
    if (backend === "file") {
      yield* Effect.promise(() =>
        withSecretsFileLock(async () => {
          const secrets = await readSecretsFileForWrite();
          if (!(account in secrets)) return;
          const { [account]: _removed, ...rest } = secrets;
          await writeSecretsFile(rest);
        }),
      ).pipe(Effect.catchAll(() => Effect.void));
      return;
    }
    yield* adoptLegacyEntries(backend);
    yield* osKeyringDelete(runCommand, backend, keyringServiceName(), account);
  });
}
