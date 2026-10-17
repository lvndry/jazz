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

/**
 * Base Keychain/libsecret service name. Each Jazz home keeps all its secrets in one vault entry
 * under `jazz.<home hash>.vault` (see `keyringVaultServiceName`). The bare name and
 * `jazz.<home hash>` hold only one-entry-per-secret items written by earlier versions, until the
 * home adopts them into its vault.
 */
export const KEYRING_SERVICE_NAME = "jazz";

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
 * Upper bound on items moved into the vault by one migration pass. Each move deletes the item, so
 * the loop ends when none are left; the bound only stops a keyring that keeps returning an item it
 * refuses to delete from spinning forever.
 */
const MAX_LEGACY_ENTRIES_MIGRATED = 1_000;

/**
 * The OS-keyring service scoped to one Jazz home: `jazz.<hash of the resolved home path>`.
 *
 * The OS keyring is shared by every Jazz home the user runs (`JAZZ_HOME`, `--data-dir`, test
 * homes), so account names alone would let one home read another's keys. Earlier versions kept
 * one item per secret under this service; the home's vault now lives under
 * {@link keyringVaultServiceName}, and `migrateKeyringEntriesIntoVault` folds those items into it.
 * The `"file"` backend needs no scope: `secrets.json` already lives inside the home.
 */
export function keyringServiceName(home: string = getJazzHomeDirectory()): string {
  const digest = createHash("sha256")
    .update(path.resolve(home))
    .digest("hex")
    .slice(0, HOME_SCOPE_HASH_LENGTH);
  return `${KEYRING_SERVICE_NAME}.${digest}`;
}

/**
 * The OS-keyring service holding one Jazz home's vault: a single item whose value is every secret
 * of the home. One item means one `security`/`secret-tool` process per read instead of one per
 * secret, and Jazz resolves around thirty secrets at startup.
 */
export function keyringVaultServiceName(home: string = getJazzHomeDirectory()): string {
  return `${keyringServiceName(home)}.vault`;
}

/** Whether the active home is the default `~/.jazz`, the only home that adopts the bare service's items. */
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
  return Effect.callback<CommandResult, never>((resume) => {
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
 * On macOS the `security` CLI ships with the OS, so finding it is enough. On Linux this probes an actual lookup: `secret-tool` is frequently installed
 * on machines with no session D-Bus (headless servers), where every call fails.
 * Neither OS probe succeeding falls through to `"file"` rather than `"none"` — see the
 * `KeyringBackend` doc comment for why that fallback is safe to take automatically instead
 * of asking the operator to choose it.
 */
export function detectKeyringBackend(): Effect.Effect<KeyringBackend, never> {
  return Effect.gen(function* () {
    if (keyringDisabledByEnv()) return "none" as const;

    if (process.platform === "darwin") {
      if (Bun.which("security", { PATH: process.env["PATH"] ?? "" }) !== null) {
        return "macos" as const;
      }
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

/** The account of a home's vault entry under {@link keyringVaultServiceName}. */
const VAULT_ACCOUNT = "secrets";

/** `security` exit status for "no such item" (errSecItemNotFound). */
const MACOS_ITEM_NOT_FOUND_EXIT_CODE = 44;

/**
 * How long one read of the vault answers later lookups in this process.
 *
 * Startup resolves config secrets, MCP headers and the provider-rename migration one after another,
 * well inside this window, so they share a single keyring read. A secret another process stores is
 * seen once the window has passed.
 */
const VAULT_SNAPSHOT_REUSE_MS = 2_000;

type VaultSecrets = Readonly<Record<string, string>>;

type VaultRead =
  | { readonly status: "ok"; readonly secrets: VaultSecrets }
  | { readonly status: "absent" }
  | { readonly status: "corrupt" }
  | { readonly status: "failed" };

/** Run a `security` subcommand fed on stdin, so the values it carries never appear in argv. */
function runSecurityScript(run: KeyringCommandRunner, line: string): Effect.Effect<CommandResult> {
  return run("security", ["-i"], `${line}\n`);
}

function encodeVault(secrets: VaultSecrets): string {
  return Buffer.from(JSON.stringify(secrets), "utf8").toString("base64");
}

/**
 * The vault is base64-encoded JSON: `security -w` prints a value with non-ASCII bytes as hex instead
 * of text, and base64 keeps every secret's characters out of that path.
 */
function decodeVault(raw: string): VaultSecrets | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw.trim(), "base64").toString("utf8"));
    if (!isRecord(parsed)) {
      return undefined;
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return undefined;
  }
}

function osKeyringReadVault(
  run: KeyringCommandRunner,
  backend: OsKeyringBackend,
  service: string,
): Effect.Effect<VaultRead, never> {
  return Effect.gen(function* () {
    const result =
      backend === "macos"
        ? yield* run("security", [
            "find-generic-password",
            "-w",
            "-s",
            service,
            "-a",
            VAULT_ACCOUNT,
          ])
        : yield* run("secret-tool", ["lookup", "service", service, "account", VAULT_ACCOUNT]);
    if (!result.ok) {
      const absent =
        backend === "macos"
          ? result.code === MACOS_ITEM_NOT_FOUND_EXIT_CODE
          : !result.unavailable && result.stderr.trim() === "";
      return absent ? { status: "absent" } : { status: "failed" };
    }
    const secrets = decodeVault(result.stdout);
    return secrets === undefined ? { status: "corrupt" } : { status: "ok", secrets };
  });
}

function osKeyringWriteVault(
  run: KeyringCommandRunner,
  backend: OsKeyringBackend,
  service: string,
  secrets: VaultSecrets,
): Effect.Effect<boolean, never> {
  return Effect.gen(function* () {
    const encoded = encodeVault(secrets);
    if (backend === "macos") {
      const hex = Buffer.from(encoded, "utf8").toString("hex");
      const result = yield* runSecurityScript(
        run,
        `add-generic-password -U -s ${service} -a ${VAULT_ACCOUNT} -X ${hex}`,
      );
      return result.ok;
    }
    const result = yield* run(
      "secret-tool",
      ["store", "--label", "jazz secrets", "service", service, "account", VAULT_ACCOUNT],
      encoded,
    );
    return result.ok;
  });
}

/** Wraps a vault read-modify-write; the default holds `.secrets.lock` so processes take turns. */
export type VaultLock = <T>(operation: () => Promise<T>) => Promise<T>;

/**
 * Apply `change` to the vault as it stands in the keyring now, and store the result.
 *
 * `change` returning undefined means nothing to write. A vault that cannot be read, or that reads
 * back as something other than Jazz's encoding, is left alone and the update reports false: writing
 * over it would drop every secret it holds.
 */
function updateVault(
  run: KeyringCommandRunner,
  backend: OsKeyringBackend,
  service: string,
  change: (secrets: VaultSecrets) => VaultSecrets | undefined,
  withLock: VaultLock,
): Effect.Effect<boolean, never> {
  return Effect.promise(() =>
    withLock(async () => {
      const read = await Effect.runPromise(osKeyringReadVault(run, backend, service));
      if (read.status === "failed" || read.status === "corrupt") {
        return false;
      }
      const next = change(read.status === "ok" ? read.secrets : {});
      if (next === undefined) {
        return true;
      }
      const stored = await Effect.runPromise(osKeyringWriteVault(run, backend, service, next));
      if (stored) {
        rememberVault(backend, service, next);
      }
      return stored;
    }),
  ).pipe(Effect.catchDefect(() => Effect.succeed(false)));
}

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
 * Move every one-entry-per-secret item under `sourceService` into the vault under `vaultService`,
 * deleting each item once the vault holds its account.
 *
 * A value already in the vault wins over the item's. The pass stops at the first item it cannot
 * read or store, leaving it and the rest in place for a later attempt. Returns the accounts moved,
 * and whether `sourceService` was left empty.
 */
export function migrateKeyringEntriesIntoVault(
  backend: OsKeyringBackend,
  sourceService: string,
  vaultService: string,
  run: KeyringCommandRunner = runCommand,
  withLock: VaultLock = withSecretsFileLock,
): Effect.Effect<VaultMigration, never> {
  return Effect.gen(function* () {
    const moved: string[] = [];
    for (let attempt = 0; attempt < MAX_LEGACY_ENTRIES_MIGRATED; attempt++) {
      const account = yield* osKeyringAnyAccount(run, backend, sourceService);
      if (account === undefined) {
        return { moved, complete: true };
      }
      const value = yield* osKeyringGet(run, backend, sourceService, account);
      if (value === undefined) {
        break;
      }
      const stored = yield* updateVault(
        run,
        backend,
        vaultService,
        (secrets) => (account in secrets ? undefined : { ...secrets, [account]: value }),
        withLock,
      );
      if (!stored) {
        break;
      }
      yield* osKeyringDelete(run, backend, sourceService, account);
      moved.push(account);
    }
    return { moved, complete: false };
  });
}

/** What one pass of {@link migrateKeyringEntriesIntoVault} did. */
export interface VaultMigration {
  readonly moved: readonly string[];
  /** Whether the source service was left empty; false when an item could not be read or stored. */
  readonly complete: boolean;
}

const vaultAdoptions = new Map<string, Promise<number>>();

/**
 * Fold the active home's one-entry-per-secret items into its vault, once per process when it
 * succeeds. A pass that stopped early (the keyring refused a read or write) is forgotten once it
 * settles, so the next lookup tries again.
 *
 * The home's own `jazz.<hash>` items go first, so they win over the bare `jazz` service's. Only
 * `~/.jazz` adopts the bare service: it is the home those keys were almost always written from,
 * and a throwaway `JAZZ_HOME` must never claim, and then lose with its directory, the user's real
 * keys. Resolves to how many items moved.
 */
function adoptPerEntrySecrets(backend: OsKeyringBackend, vaultService: string): Promise<number> {
  const key = `${backend}:${vaultService}`;
  let pending = vaultAdoptions.get(key);
  if (pending === undefined) {
    const sources = [keyringServiceName(), ...(isDefaultJazzHome() ? [KEYRING_SERVICE_NAME] : [])];
    const migrateAll = async (): Promise<{ movedCount: number; complete: boolean }> => {
      let movedCount = 0;
      let complete = true;
      for (const source of sources) {
        const migration = await Effect.runPromise(
          migrateKeyringEntriesIntoVault(backend, source, vaultService),
        );
        movedCount += migration.moved.length;
        complete &&= migration.complete;
      }
      return { movedCount, complete };
    };
    const attempt: Promise<number> = migrateAll().then(({ movedCount, complete }) => {
      if (!complete && vaultAdoptions.get(key) === attempt) {
        vaultAdoptions.delete(key);
      }
      return movedCount;
    });
    pending = attempt;
    vaultAdoptions.set(key, pending);
  }
  return pending;
}

interface VaultSnapshot {
  readonly secrets: Promise<VaultSecrets>;
  readonly readAtMs: number;
}

const vaultSnapshots = new Map<string, VaultSnapshot>();

function rememberVault(backend: OsKeyringBackend, service: string, secrets: VaultSecrets): void {
  vaultSnapshots.set(`${backend}:${service}`, {
    secrets: Promise.resolve(secrets),
    readAtMs: Date.now(),
  });
}

/**
 * Every secret in the active home's vault, from one keyring read shared by every lookup made
 * within {@link VAULT_SNAPSHOT_REUSE_MS}. The first read in a process also adopts per-entry items
 * left by earlier versions; it runs beside the vault read, and the vault is read again only when
 * something moved.
 */
function readVault(backend: OsKeyringBackend): Effect.Effect<VaultSecrets, never> {
  return Effect.promise(() => {
    const service = keyringVaultServiceName();
    const key = `${backend}:${service}`;
    const now = Date.now();
    const cached = vaultSnapshots.get(key);
    if (cached !== undefined && now - cached.readAtMs < VAULT_SNAPSHOT_REUSE_MS) {
      return cached.secrets;
    }
    const readSecrets = async (): Promise<VaultSecrets> => {
      const read = await Effect.runPromise(osKeyringReadVault(runCommand, backend, service));
      return read.status === "ok" ? read.secrets : {};
    };
    const secrets = (async () => {
      const [initial, movedCount] = await Promise.all([
        readSecrets(),
        adoptPerEntrySecrets(backend, service),
      ]);
      return movedCount > 0 ? readSecrets() : initial;
    })();
    vaultSnapshots.set(key, { secrets, readAtMs: now });
    return secrets;
  });
}

/** Read a secret. Returns undefined when absent or unreadable. */
export function keyringGet(
  backend: KeyringBackend,
  account: string,
): Effect.Effect<string | undefined, never> {
  return keyringReadAll(backend).pipe(Effect.map((secrets) => secrets[account]));
}

/** Every secret the backend holds for the active home, keyed by account. */
export function keyringReadAll(backend: KeyringBackend): Effect.Effect<VaultSecrets, never> {
  if (backend === "none") return Effect.succeed({});
  if (backend === "file") return readSecretsFile();
  return readVault(backend);
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
      ).pipe(Effect.catch(() => Effect.succeed(false)));
    }
    const service = keyringVaultServiceName();
    yield* Effect.promise(() => adoptPerEntrySecrets(backend, service));
    return yield* updateVault(
      runCommand,
      backend,
      service,
      (secrets) => (secrets[account] === secret ? undefined : { ...secrets, [account]: secret }),
      withSecretsFileLock,
    );
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
      ).pipe(Effect.catch(() => Effect.void));
      return;
    }
    // Adopt first: an item adopted after this delete would bring the secret back.
    const service = keyringVaultServiceName();
    yield* Effect.promise(() => adoptPerEntrySecrets(backend, service));
    yield* updateVault(
      runCommand,
      backend,
      service,
      (secrets) => {
        if (!(account in secrets)) return undefined;
        const { [account]: _removed, ...rest } = secrets;
        return rest;
      },
      withSecretsFileLock,
    );
  });
}
