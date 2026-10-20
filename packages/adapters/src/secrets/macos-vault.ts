/**
 * A Jazz home's vault in the macOS keychain, kept in items that `/usr/bin/security` alone creates,
 * reads and deletes. The login keychain asks for its password whenever an item is read by a
 * program other than the one that wrote it, so no other program may write these items.
 *
 * Values travel on the stdin of `security -i`, never in argv, where other local users could read
 * them. `security -i` refuses command lines over 4,095 bytes, so the encoded vault is split into
 * chunks, one item each, and a single `security -i` process reads every chunk at once.
 *
 * Chunks live in two slots. A write fills the slot not holding the current vault with the next
 * generation, then deletes the previous slot's items. Readers take the newest complete generation,
 * so a write interrupted partway, or a read racing a write, still sees the previous vault whole.
 */
import { Effect } from "effect";
import { logDebug, logWarning } from "../logger";
import type { CommandResult, KeyringCommandRunner } from "./keyring";

/**
 * Encoded characters per chunk. The longest `add-generic-password` line it produces stays under the
 * 4,095-byte line limit of `security -i` with room for the service, account and chunk header.
 */
export const MACOS_VAULT_CHUNK_LENGTH = 3_800;

/** Chunks per slot: room for an encoded vault of {@link MACOS_VAULT_CHUNK_LENGTH} × 32 characters. */
export const MACOS_VAULT_MAX_CHUNKS = 32;

const SLOTS = ["a", "b"] as const;
type Slot = (typeof SLOTS)[number];

/** Security.framework's errSecItemNotFound, as `security -i` reports a lookup that found nothing. */
const ITEM_NOT_FOUND_STATUS = -25300;

/** `<slot>.<generation>.<index>.<count>.<base64 slice>`; each chunk names its own place. */
const CHUNK_PATTERN = /^([ab])\.(\d+)\.(\d+)\.(\d+)\.([A-Za-z0-9+/=]*)$/;

const FAILED_COMMAND_PATTERN = /returned (-?\d+)/g;

/** Where the vault's chunks sit in the keychain, for the next write. */
export interface MacosVaultLayout {
  /** The slot and generation of the newest complete vault, when there is one. */
  readonly current?: { readonly slot: Slot; readonly generation: number };
  /** Every chunk account found, complete or not, so a write can retire the ones it replaces. */
  readonly accounts: readonly string[];
}

export type MacosVaultRead =
  | { readonly status: "ok"; readonly encoded: string; readonly layout: MacosVaultLayout }
  | { readonly status: "absent"; readonly layout: MacosVaultLayout }
  | { readonly status: "failed" };

export function macosVaultChunkAccount(slot: Slot, index: number): string {
  return `vault.${slot}.${index}`;
}

/** The statuses a `security -i` session's failed commands reported, for diagnostics. */
function failedStatuses(stderr: string): number[] {
  return [...stderr.matchAll(FAILED_COMMAND_PATTERN)]
    .map((match) => Number(match[1]))
    .filter((status) => status !== ITEM_NOT_FOUND_STATUS);
}

/**
 * Whether a `security -i` session did not run to the end, or one of its commands failed for a
 * reason other than a missing item. Its exit status is only the last command's, so a session whose
 * final lookup found nothing exits nonzero even though it succeeded.
 */
function sessionFailed(result: CommandResult): boolean {
  return (
    result.unavailable ||
    result.code === null ||
    [...result.stderr.matchAll(FAILED_COMMAND_PATTERN)].some(
      (match) => Number(match[1]) !== ITEM_NOT_FOUND_STATUS,
    )
  );
}

interface Chunk {
  readonly slot: Slot;
  readonly generation: number;
  readonly index: number;
  readonly count: number;
  readonly slice: string;
}

function parseChunk(line: string): Chunk | undefined {
  const match = CHUNK_PATTERN.exec(line.trim());
  if (match === null) {
    return undefined;
  }
  const [, slot, generation, index, count, slice] = match;
  return {
    slot: slot as Slot,
    generation: Number(generation),
    index: Number(index),
    count: Number(count),
    slice: slice ?? "",
  };
}

/**
 * The newest generation whose every chunk is present. Chunks are grouped by slot and generation,
 * so leftovers of an older or interrupted write never mix into a vault.
 */
export function assembleMacosVault(lines: readonly string[]): MacosVaultLayout & {
  readonly encoded?: string;
} {
  const groups = new Map<string, Chunk[]>();
  const accounts: string[] = [];
  for (const line of lines) {
    const chunk = parseChunk(line);
    if (chunk === undefined) {
      continue;
    }
    accounts.push(macosVaultChunkAccount(chunk.slot, chunk.index));
    const key = `${chunk.slot}.${chunk.generation}`;
    groups.set(key, [...(groups.get(key) ?? []), chunk]);
  }
  const complete = [...groups.values()]
    .filter((chunks) => {
      const count = chunks[0]?.count ?? 0;
      const indices = new Set(chunks.map((chunk) => chunk.index));
      return (
        count > 0 &&
        chunks.every((chunk) => chunk.count === count) &&
        indices.size === count &&
        [...indices].every((index) => index < count)
      );
    })
    .sort((left, right) => (right[0]?.generation ?? 0) - (left[0]?.generation ?? 0));
  const newest = complete[0];
  if (newest === undefined || newest[0] === undefined) {
    return { accounts };
  }
  const ordered = [...newest].sort((left, right) => left.index - right.index);
  return {
    current: { slot: newest[0].slot, generation: newest[0].generation },
    accounts,
    encoded: ordered.map((chunk) => chunk.slice).join(""),
  };
}

/** The `security -i` script reading every chunk of both slots. */
export function macosVaultReadScript(service: string): string {
  return SLOTS.flatMap((slot) =>
    Array.from(
      { length: MACOS_VAULT_MAX_CHUNKS },
      (_, index) =>
        `find-generic-password -w -s ${service} -a ${macosVaultChunkAccount(slot, index)}\n`,
    ),
  ).join("");
}

export function readMacosVault(
  run: KeyringCommandRunner,
  service: string,
): Effect.Effect<MacosVaultRead> {
  return run("security", ["-i"], macosVaultReadScript(service)).pipe(
    Effect.map((result): MacosVaultRead => {
      if (sessionFailed(result)) {
        logWarning("keyring: macOS vault read failed", {
          service,
          statuses: failedStatuses(result.stderr),
          exitCode: result.code,
          unavailable: result.unavailable,
          timedOut: result.timedOut === true,
        });
        return { status: "failed" };
      }
      const { encoded, ...layout } = assembleMacosVault(result.stdout.split("\n"));
      return encoded === undefined
        ? { status: "absent", layout }
        : { status: "ok", encoded, layout };
    }),
  );
}

/**
 * The `security -i` script storing `encoded` as the next generation in the slot `previous` does not
 * hold, or undefined when the vault needs more than {@link MACOS_VAULT_MAX_CHUNKS} chunks.
 */
export function macosVaultWriteScript(
  service: string,
  encoded: string,
  previous: MacosVaultLayout,
): { readonly script: string; readonly accounts: readonly string[] } | undefined {
  const slot: Slot = previous.current?.slot === "a" ? "b" : "a";
  const generation = (previous.current?.generation ?? 0) + 1;
  const count = Math.max(1, Math.ceil(encoded.length / MACOS_VAULT_CHUNK_LENGTH));
  if (count > MACOS_VAULT_MAX_CHUNKS) {
    return undefined;
  }
  const accounts: string[] = [];
  let script = "";
  for (let index = 0; index < count; index++) {
    const slice = encoded.slice(
      index * MACOS_VAULT_CHUNK_LENGTH,
      (index + 1) * MACOS_VAULT_CHUNK_LENGTH,
    );
    const account = macosVaultChunkAccount(slot, index);
    accounts.push(account);
    script += `add-generic-password -U -s ${service} -a ${account} -w ${slot}.${generation}.${index}.${count}.${slice}\n`;
  }
  return { script, accounts };
}

/**
 * Store `encoded` as the vault, then delete every chunk the new generation does not use. Returns
 * false when the vault is too large or a chunk could not be stored; the previous vault then stays
 * in force. A failed cleanup still reports true: readers already prefer the new generation, and
 * the next write retries the cleanup.
 */
export function writeMacosVault(
  run: KeyringCommandRunner,
  service: string,
  encoded: string,
  previous: MacosVaultLayout,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const write = macosVaultWriteScript(service, encoded, previous);
    if (write === undefined) {
      logWarning("keyring: macOS vault too large to store", {
        service,
        encodedLength: encoded.length,
        maxLength: MACOS_VAULT_CHUNK_LENGTH * MACOS_VAULT_MAX_CHUNKS,
      });
      return false;
    }
    const stored = yield* run("security", ["-i"], write.script);
    if (sessionFailed(stored)) {
      logWarning("keyring: macOS vault write failed; the previous vault stays in force", {
        service,
        chunks: write.accounts.length,
        statuses: failedStatuses(stored.stderr),
        exitCode: stored.code,
        unavailable: stored.unavailable,
        timedOut: stored.timedOut === true,
      });
      return false;
    }
    const kept = new Set(write.accounts);
    const retired = [...new Set(previous.accounts)].filter((account) => !kept.has(account));
    if (retired.length > 0) {
      const cleanup = yield* run(
        "security",
        ["-i"],
        retired.map((account) => `delete-generic-password -s ${service} -a ${account}\n`).join(""),
      );
      if (sessionFailed(cleanup)) {
        logWarning("keyring: replaced macOS vault chunks not all deleted; the next write retries", {
          service,
          retired: retired.length,
          statuses: failedStatuses(cleanup.stderr),
        });
      }
    }
    logDebug("keyring: wrote macOS vault", {
      service,
      chunks: write.accounts.length,
      retired: retired.length,
    });
    return true;
  });
}
