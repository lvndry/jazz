/**
 * Prevents a forgotten or superseded user statement from being saved again.
 *
 * A claim is tracked by the sentences it quoted, as hashed sentence keys, never
 * as text. Correcting or forgetting an entry revokes exactly those sentences, so
 * compaction cannot re-save the old claim while other facts from the same message
 * stay quotable.
 *
 * Every function here must run inside `withMemoryWriteLock`; the ledger is one
 * file for all scopes and has no lock of its own. A malformed ledger pauses cited
 * writes, but never blocks forgetting.
 */

import * as path from "node:path";
import { FileSystem } from "@effect/platform";
import { toError } from "@jazz/core/utils/errors";
import { writeFileStringAtomic } from "@jazz/core/utils/storage";
import { Effect } from "effect";

const LEDGER_FILENAME = ".source-ledger.json";

/**
 * Revoked sentence keys kept. Past this the oldest are dropped: forgetting must
 * never fail for lack of room, and a sentence that old is rarely still in a live
 * transcript for compaction to re-save.
 */
const MAX_REVOKED_SENTENCE_KEYS = 16_384;

/** Entries tracked; one per memory file written from a cited quote. */
const MAX_TRACKED_CLAIMS = 16_384;

/** A sentence key is a sha256 hex digest. */
const SENTENCE_KEY_PATTERN = /^[a-f0-9]{64}$/;

interface SourceLedger {
  /** The sentence keys each file's current claim was quoted from, by scope-relative path. */
  readonly sentenceKeysByPath: Readonly<Record<string, readonly string[]>>;
  /** Oldest first, so eviction drops the least recent revocation. */
  readonly revokedSentenceKeys: readonly string[];
}

const EMPTY_LEDGER: SourceLedger = { sentenceKeysByPath: {}, revokedSentenceKeys: [] };

class UnreadableLedger extends Error {
  constructor() {
    super("Memory source ledger is unreadable; cited writes are paused.");
  }
}

function ledgerPath(memoryDirectory: string): string {
  return path.join(memoryDirectory, LEDGER_FILENAME);
}

function isSentenceKeyList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((key) => typeof key === "string" && SENTENCE_KEY_PATTERN.test(key))
  );
}

function parseLedger(raw: string): SourceLedger {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new UnreadableLedger();
  }
  const { sentenceKeysByPath, revokedSentenceKeys } = parsed as Partial<
    Record<keyof SourceLedger, unknown>
  >;
  if (
    typeof sentenceKeysByPath !== "object" ||
    sentenceKeysByPath === null ||
    Array.isArray(sentenceKeysByPath) ||
    !Object.values(sentenceKeysByPath).every(isSentenceKeyList) ||
    !isSentenceKeyList(revokedSentenceKeys)
  ) {
    throw new UnreadableLedger();
  }
  return {
    sentenceKeysByPath: Object.assign(
      Object.create(null) as Record<string, readonly string[]>,
      sentenceKeysByPath,
    ),
    revokedSentenceKeys,
  };
}

/** Read a missing ledger as empty and fail with `UnreadableLedger` for a malformed one. */
function readLedger(
  fs: FileSystem.FileSystem,
  memoryDirectory: string,
): Effect.Effect<SourceLedger, Error> {
  const file = ledgerPath(memoryDirectory);
  return Effect.gen(function* () {
    const exists = yield* fs.exists(file).pipe(Effect.mapError(toError));
    if (!exists) {
      return EMPTY_LEDGER;
    }
    const raw = yield* fs.readFileString(file).pipe(Effect.mapError(toError));
    return yield* Effect.try({ try: () => parseLedger(raw), catch: () => new UnreadableLedger() });
  });
}

function writeLedger(
  fs: FileSystem.FileSystem,
  memoryDirectory: string,
  ledger: SourceLedger,
): Effect.Effect<void, Error> {
  const trackedClaims = Object.keys(ledger.sentenceKeysByPath).length;
  if (trackedClaims > MAX_TRACKED_CLAIMS) {
    return Effect.fail(new Error("Memory source ledger tracks too many entries."));
  }
  const revokedSentenceKeys = ledger.revokedSentenceKeys.slice(-MAX_REVOKED_SENTENCE_KEYS);
  return writeFileStringAtomic(
    fs,
    ledgerPath(memoryDirectory),
    `${JSON.stringify({ ...ledger, revokedSentenceKeys })}\n`,
    { tempPrefix: "memory-source-ledger" },
  );
}

function withRevoked(
  revoked: readonly string[],
  sentenceKeys: Iterable<string>,
): readonly string[] {
  const alreadyRevoked = new Set(revoked);
  const added = [...new Set(sentenceKeys)].filter((key) => !alreadyRevoked.has(key));
  return added.length === 0 ? revoked : [...revoked, ...added];
}

function isUnder(candidatePath: string, relativePath: string): boolean {
  return candidatePath === relativePath || candidatePath.startsWith(`${relativePath}/`);
}

/**
 * Record the sentences a file's new claim quotes, or return `false` when any of
 * them was forgotten or superseded. Sentences the previous claim quoted and the
 * new one does not are revoked before the content changes.
 */
export function recordClaimSentences(
  fs: FileSystem.FileSystem,
  memoryDirectory: string,
  relativePath: string,
  sentenceKeys: readonly string[] | undefined,
): Effect.Effect<boolean, Error> {
  if (sentenceKeys === undefined) {
    return Effect.succeed(true);
  }
  if (sentenceKeys.length === 0 || !isSentenceKeyList(sentenceKeys)) {
    return Effect.fail(new Error("Memory source sentence keys are invalid."));
  }
  return Effect.gen(function* () {
    const ledger = yield* readLedger(fs, memoryDirectory);
    const revoked = new Set(ledger.revokedSentenceKeys);
    if (sentenceKeys.some((key) => revoked.has(key))) {
      return false;
    }
    const kept = new Set(sentenceKeys);
    const superseded = (ledger.sentenceKeysByPath[relativePath] ?? []).filter(
      (key) => !kept.has(key),
    );
    yield* writeLedger(fs, memoryDirectory, {
      sentenceKeysByPath: { ...ledger.sentenceKeysByPath, [relativePath]: [...kept] },
      revokedSentenceKeys: withRevoked(ledger.revokedSentenceKeys, superseded),
    });
    return true;
  });
}

/**
 * Revoke every sentence quoted by claims at or under `relativePath`, before the
 * files are deleted. An unreadable ledger is left alone and the delete goes
 * ahead: it already pauses cited writes, so nothing can re-save the claim.
 */
export function revokeClaimSentencesUnder(
  fs: FileSystem.FileSystem,
  memoryDirectory: string,
  relativePath: string,
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const ledger = yield* readLedger(fs, memoryDirectory);
    const remaining = Object.create(null) as Record<string, readonly string[]>;
    const revokedNow: string[] = [];
    for (const [trackedPath, sentenceKeys] of Object.entries(ledger.sentenceKeysByPath)) {
      if (isUnder(trackedPath, relativePath)) {
        revokedNow.push(...sentenceKeys);
      } else {
        remaining[trackedPath] = sentenceKeys;
      }
    }
    if (revokedNow.length === 0) {
      return;
    }
    yield* writeLedger(fs, memoryDirectory, {
      sentenceKeysByPath: remaining,
      revokedSentenceKeys: withRevoked(ledger.revokedSentenceKeys, revokedNow),
    });
  }).pipe(
    Effect.catchIf(
      (error) => error instanceof UnreadableLedger,
      () => Effect.void,
    ),
  );
}

/** Move tracked claims to their new path once the files themselves have moved. */
export function moveClaimSentences(
  fs: FileSystem.FileSystem,
  memoryDirectory: string,
  fromPath: string,
  toPath: string,
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const ledger = yield* readLedger(fs, memoryDirectory);
    const moved = Object.create(null) as Record<string, readonly string[]>;
    let changed = false;
    for (const [trackedPath, sentenceKeys] of Object.entries(ledger.sentenceKeysByPath)) {
      if (isUnder(trackedPath, fromPath)) {
        moved[`${toPath}${trackedPath.slice(fromPath.length)}`] = sentenceKeys;
        changed = true;
      } else {
        moved[trackedPath] = sentenceKeys;
      }
    }
    if (changed) {
      yield* writeLedger(fs, memoryDirectory, {
        sentenceKeysByPath: moved,
        revokedSentenceKeys: ledger.revokedSentenceKeys,
      });
    }
  }).pipe(
    Effect.catchIf(
      (error) => error instanceof UnreadableLedger,
      () => Effect.void,
    ),
  );
}
