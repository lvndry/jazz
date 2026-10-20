/**
 * Home-scoped credential storage through macOS Keychain, libsecret, or a private file fallback.
 * `keyringGet` and `keyringReadAll` share a short-lived vault snapshot; writes are serialized and
 * update that snapshot. Legacy per-entry credentials are adopted before vault use, with one
 * shared migration attempt and retries after incomplete attempts. Callers receive absent/false
 * outcomes on unavailable stores; secret values are never included in diagnostics or arguments.
 */

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
import { readMacosKeychainItem } from "./macos-keychain";
import { type MacosVaultLayout, readMacosVault, writeMacosVault } from "./macos-vault";

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
 * - `"macos"` — Keychain. The vault goes through Security.framework via `osascript` (see
 *   `macos-keychain.ts`); per-secret items from earlier versions via the `security` CLI.
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

/**
 * How long a keychain read that may show a password dialog waits when someone is at the terminal:
 * time to read the dialog and type a password. Unattended runs keep {@link COMMAND_TIMEOUT_MS}, so
 * they never hang on a dialog nobody will answer.
 */
const KEYCHAIN_DIALOG_TIMEOUT_MS = 60_000;

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
  timeoutMs?: number,
) => Effect.Effect<CommandResult, never>;

function runCommand(
  command: string,
  args: readonly string[],
  stdin?: string,
  timeoutMs: number = COMMAND_TIMEOUT_MS,
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
    }, timeoutMs);

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

/**
 * The account of a home's vault entry under {@link keyringVaultServiceName} on Linux. On macOS it
 * names the single-item vault 0.16.19 and 0.16.20 wrote through `osascript`, which
 * `adoptMacosOsascriptVault` folds into the chunked vault of `macos-vault.ts`.
 */
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

/** `macosLayout` is where the macOS vault's chunks sit, which the next write builds on. */
type VaultRead =
  | {
      readonly status: "ok";
      readonly secrets: VaultSecrets;
      readonly macosLayout?: MacosVaultLayout;
    }
  | { readonly status: "absent"; readonly macosLayout?: MacosVaultLayout }
  | { readonly status: "corrupt" }
  | { readonly status: "failed" };

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
    if (backend === "macos") {
      const read = yield* readMacosVault(run, service);
      if (read.status === "failed") {
        return read;
      }
      if (read.status === "absent") {
        return { status: "absent", macosLayout: read.layout };
      }
      const secrets = decodeVault(read.encoded);
      return secrets === undefined
        ? { status: "corrupt" }
        : { status: "ok", secrets, macosLayout: read.layout };
    }
    const result = yield* run("secret-tool", [
      "lookup",
      "service",
      service,
      "account",
      VAULT_ACCOUNT,
    ]);
    if (!result.ok) {
      const absent = !result.unavailable && result.stderr.trim() === "";
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
  macosLayout: MacosVaultLayout = { accounts: [] },
): Effect.Effect<boolean, never> {
  return Effect.gen(function* () {
    const encoded = encodeVault(secrets);
    if (backend === "macos") {
      return yield* writeMacosVault(run, service, encoded, macosLayout);
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
    withLock(() => Effect.runPromise(updateVaultWhileLocked(run, backend, service, change))),
  ).pipe(Effect.catchDefect(() => Effect.succeed(false)));
}

/** Read and update the vault while the caller holds the home's secrets lock. */
function updateVaultWhileLocked(
  run: KeyringCommandRunner,
  backend: OsKeyringBackend,
  service: string,
  change: (secrets: VaultSecrets) => VaultSecrets | undefined,
): Effect.Effect<boolean, never> {
  return Effect.gen(function* () {
    const read = yield* osKeyringReadVault(run, backend, service);
    if (read.status === "failed" || read.status === "corrupt") return false;
    const next = change(read.status === "ok" ? read.secrets : {});
    if (next === undefined) return true;
    const stored = yield* osKeyringWriteVault(run, backend, service, next, read.macosLayout);
    if (stored) rememberVault(backend, service, next);
    return stored;
  });
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
): Effect.Effect<boolean, never> {
  return Effect.gen(function* () {
    const result =
      backend === "macos"
        ? yield* run("security", ["delete-generic-password", "-s", service, "-a", account])
        : yield* run("secret-tool", ["clear", "service", service, "account", account]);
    return result.ok;
  });
}

type LegacyAccountRead =
  | { readonly status: "found"; readonly account: string }
  | { readonly status: "absent" }
  | { readonly status: "failed" };

/**
 * Discover a legacy entry without treating a failed keyring command as an empty service.
 * macOS reports missing entries with exit 44. `secret-tool search` succeeds even with no
 * matches; a nonzero exit or nonempty output without a parseable account is incomplete.
 */
function osKeyringAnyAccount(
  run: KeyringCommandRunner,
  backend: OsKeyringBackend,
  service: string,
): Effect.Effect<LegacyAccountRead, never> {
  return Effect.gen(function* () {
    const result =
      backend === "macos"
        ? yield* run("security", ["find-generic-password", "-s", service])
        : yield* run("secret-tool", ["search", "service", service]);
    if (!result.ok) {
      return backend === "macos" &&
        !result.unavailable &&
        result.code === MACOS_ITEM_NOT_FOUND_EXIT_CODE
        ? { status: "absent" }
        : { status: "failed" };
    }
    const output = `${result.stdout}\n${result.stderr}`;
    const hexMatch = backend === "macos" ? /^\s*"acct"<blob>=0x([0-9A-Fa-f]+)/m.exec(output) : null;
    const account =
      hexMatch?.[1] !== undefined
        ? Buffer.from(hexMatch[1], "hex").toString("utf8")
        : backend === "macos"
          ? /^\s*"acct"<blob>="(.*)"\s*$/m.exec(output)?.[1]
          : /^attribute\.account = (.*)$/m.exec(output)?.[1];
    if (account !== undefined) return { status: "found", account };
    return backend === "libsecret" && output.trim() === ""
      ? { status: "absent" }
      : { status: "failed" };
  });
}

/** Migration progress and whether the source was successfully observed to be empty. */
export interface VaultMigration {
  readonly moved: readonly string[];
  readonly complete: boolean;
  /** The keychain refused to read the source: a denied or unanswered password dialog. */
  readonly refused?: boolean;
}

/**
 * Move per-entry credentials into a home's vault, deleting only after the vault holds them.
 * The same secrets lock covers reading the legacy value, updating the vault, and retiring the
 * source, so another process cannot restore a value deleted while this pass waited for the lock.
 * Existing vault values win. Read, write, discovery, or deletion failures stop the pass with
 * `complete: false`; completed moves remain stored, and the next attempt resumes the source.
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
      const discovered = yield* osKeyringAnyAccount(run, backend, sourceService);
      if (discovered.status !== "found") {
        return { moved, complete: discovered.status === "absent" };
      }
      const { account } = discovered;
      const result = yield* Effect.promise(() =>
        withLock(async () => {
          const value = await Effect.runPromise(osKeyringGet(run, backend, sourceService, account));
          if (value === undefined) return { copied: false, retired: false };
          const stored = await Effect.runPromise(
            updateVaultWhileLocked(run, backend, vaultService, (secrets) =>
              account in secrets ? undefined : { ...secrets, [account]: value },
            ),
          );
          if (!stored) return { copied: false, retired: false };
          const retired = await Effect.runPromise(
            osKeyringDelete(run, backend, sourceService, account),
          );
          return { copied: true, retired };
        }),
      ).pipe(Effect.catchDefect(() => Effect.succeed({ copied: false, retired: false })));
      if (result.copied) moved.push(account);
      if (!result.retired) return { moved, complete: false };
    }
    return { moved, complete: false };
  });
}

/**
 * Fold the single-item vault that 0.16.19 and 0.16.20 wrote through `osascript` into the chunked
 * vault, then delete it. Only `osascript` reads that item, since it wrote it; `security` can still
 * find and delete it silently, so the lookup that runs on every start costs one `security` call and
 * `osascript` runs only while the item exists. A vault a pre-release build created through
 * `security` and then rewrote through `osascript` makes even `osascript` show a password dialog, so
 * at a terminal the read waits {@link KEYCHAIN_DIALOG_TIMEOUT_MS} for an answer. It happens before
 * taking the secrets lock, which other processes would otherwise wait on; under the lock the item
 * is looked up again, and a pass that finds it already adopted stops there.
 *
 * Values already in the chunked vault win. An item that does not decode is left alone and skipped:
 * no version of Jazz could read it.
 */
export function adoptMacosOsascriptVault(
  vaultService: string,
  run: KeyringCommandRunner = runCommand,
  withLock: VaultLock = withSecretsFileLock,
  interactive: boolean = process.stdin.isTTY === true,
): Effect.Effect<VaultMigration, never> {
  const discover = run("security", [
    "find-generic-password",
    "-s",
    vaultService,
    "-a",
    VAULT_ACCOUNT,
  ]);
  return Effect.gen(function* () {
    const discovered = yield* discover;
    if (!discovered.ok) {
      const absent = !discovered.unavailable && discovered.code === MACOS_ITEM_NOT_FOUND_EXIT_CODE;
      return { moved: [], complete: absent };
    }
    const read = yield* readMacosKeychainItem(
      run,
      { service: vaultService, account: VAULT_ACCOUNT },
      interactive ? KEYCHAIN_DIALOG_TIMEOUT_MS : COMMAND_TIMEOUT_MS,
    );
    if (read.status === "failed") {
      return { moved: [], complete: false, refused: true };
    }
    const legacy = read.status === "ok" ? decodeVault(read.value) : {};
    if (legacy === undefined) {
      return { moved: [], complete: true };
    }
    return yield* Effect.promise(() =>
      withLock(async (): Promise<VaultMigration> => {
        const stillThere = await Effect.runPromise(discover);
        if (!stillThere.ok) {
          const absent =
            !stillThere.unavailable && stillThere.code === MACOS_ITEM_NOT_FOUND_EXIT_CODE;
          return { moved: [], complete: absent };
        }
        const moved: string[] = [];
        const stored = await Effect.runPromise(
          updateVaultWhileLocked(run, "macos", vaultService, (secrets) => {
            moved.push(...Object.keys(legacy).filter((account) => !(account in secrets)));
            return moved.length === 0
              ? undefined
              : {
                  ...secrets,
                  ...Object.fromEntries(moved.map((account) => [account, legacy[account] ?? ""])),
                };
          }),
        );
        if (!stored) {
          return { moved: [], complete: false };
        }
        const retired = await Effect.runPromise(
          osKeyringDelete(run, "macos", vaultService, VAULT_ACCOUNT),
        );
        return { moved, complete: retired };
      }),
    ).pipe(Effect.catchDefect(() => Effect.succeed({ moved: [], complete: false })));
  });
}

interface VaultAdoptionResult {
  readonly movedCount: number;
  readonly complete: boolean;
}

const vaultAdoptions = new Map<string, Promise<VaultAdoptionResult>>();

/**
 * Vault services whose `osascript`-written vault the keychain refused to read in this process. A
 * refused read means a password dialog was denied or left unanswered; asking again on every lookup
 * puts a dialog in front of every message, so the process stops asking and the next process asks
 * once more.
 */
const refusedOsascriptVaults = new Set<string>();

/**
 * Fold legacy credentials into the active vault with one in-flight attempt per home.
 * Complete adoptions stay cached for the process; incomplete attempts are evicted for retry.
 *
 * The home's own `jazz.<hash>` items go first, so they win over the bare `jazz` service's. Only
 * `~/.jazz` adopts the bare service: it is the home those keys were almost always written from,
 * and a throwaway `JAZZ_HOME` must never claim, and then lose with its directory, the user's real
 * keys. An incomplete scoped pass stops before the bare service, preserving that precedence.
 *
 * On macOS the `osascript`-written vault goes first, its values being the newest. When the keychain
 * refuses to read it, the per-secret items still move, so their keys stay reachable, and the
 * adoption stays incomplete until a later process reads that vault.
 */
function adoptPerEntrySecrets(
  backend: OsKeyringBackend,
  vaultService: string,
): Promise<VaultAdoptionResult> {
  const key = `${backend}:${vaultService}`;
  let pending = vaultAdoptions.get(key);
  if (pending === undefined) {
    const sources = [keyringServiceName(), ...(isDefaultJazzHome() ? [KEYRING_SERVICE_NAME] : [])];
    pending = (async () => {
      let movedCount = 0;
      let osascriptVaultAdopted = true;
      if (backend === "macos") {
        if (refusedOsascriptVaults.has(vaultService)) {
          osascriptVaultAdopted = false;
        } else {
          const result = await Effect.runPromise(adoptMacosOsascriptVault(vaultService));
          movedCount += result.moved.length;
          osascriptVaultAdopted = result.complete;
          if (result.refused === true) {
            refusedOsascriptVaults.add(vaultService);
          }
          if (!result.complete && result.refused !== true) {
            return { movedCount, complete: false };
          }
        }
      }
      for (const source of sources) {
        const result = await Effect.runPromise(
          migrateKeyringEntriesIntoVault(backend, source, vaultService),
        );
        movedCount += result.moved.length;
        if (!result.complete) return { movedCount, complete: false };
      }
      return { movedCount, complete: osascriptVaultAdopted };
    })();
    vaultAdoptions.set(key, pending);
  }
  const attempt = pending;
  return attempt.then(
    (result) => {
      if (!result.complete && vaultAdoptions.get(key) === attempt) vaultAdoptions.delete(key);
      return result;
    },
    (error: unknown) => {
      if (vaultAdoptions.get(key) === attempt) vaultAdoptions.delete(key);
      throw error;
    },
  );
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
 * within {@link VAULT_SNAPSHOT_REUSE_MS}. An uncached read also attempts legacy adoption until
 * it completes; incomplete attempts retry after the snapshot expires. Adoption runs beside the
 * vault read, and the vault is read again only when something moved.
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
      const [initial, adoption] = await Promise.all([
        readSecrets(),
        adoptPerEntrySecrets(backend, service),
      ]);
      return adoption.movedCount > 0 ? readSecrets() : initial;
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

/**
 * Remove a secret. Missing entries are not an error. An incomplete legacy adoption leaves the
 * vault untouched, because deleting before the remaining source is adopted could resurrect it
 * on retry. Callers may retry once the keyring is available again.
 */
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
    const service = keyringVaultServiceName();
    const adoption = yield* Effect.promise(() => adoptPerEntrySecrets(backend, service));
    if (!adoption.complete) return;
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
