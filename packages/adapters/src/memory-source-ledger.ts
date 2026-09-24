/**
 * Prevents a forgotten or superseded user message from being saved again.
 *
 * The ledger keeps only source IDs, never quotes or transcript text. It is
 * updated under MemoryService's global memory write lock before the corresponding file
 * mutation, so a failed ledger write cannot turn a successful forget into a
 * later re-extraction. A malformed ledger fails closed for cited writes.
 */

import * as path from "node:path";
import { FileSystem } from "@effect/platform";
import { toError, writeFileStringAtomic } from "@jazz/core/utils/storage";
import { Effect } from "effect";

const LEDGER_FILENAME = ".source-ledger.json";
const MAX_FORGOTTEN_SOURCES = 16_384;
const MAX_TRACKED_PATHS = 16_384;
const MAX_SOURCE_ID_CHARS = 128;

interface SourceLedger {
  readonly current: Readonly<Record<string, string>>;
  readonly forgotten: readonly string[];
}

const EMPTY_LEDGER: SourceLedger = { current: {}, forgotten: [] };

function ledgerPath(root: string): string {
  return path.join(root, LEDGER_FILENAME);
}

/** Read a missing ledger as empty and reject an existing malformed one. */
function readLedger(fs: FileSystem.FileSystem, root: string): Effect.Effect<SourceLedger, Error> {
  const file = ledgerPath(root);
  return Effect.gen(function* () {
    const exists = yield* fs.exists(file).pipe(Effect.mapError(toError));
    if (!exists) return EMPTY_LEDGER;
    const raw = yield* fs.readFileString(file).pipe(Effect.mapError(toError));
    return yield* Effect.try({
      try: () => {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null) throw new Error("invalid ledger");
        const current = (parsed as { current?: unknown }).current;
        const forgotten = (parsed as { forgotten?: unknown }).forgotten;
        if (
          typeof current !== "object" ||
          current === null ||
          Array.isArray(current) ||
          Object.keys(current).length > MAX_TRACKED_PATHS ||
          !Object.values(current).every(
            (value) => typeof value === "string" && value.length <= MAX_SOURCE_ID_CHARS,
          ) ||
          !Array.isArray(forgotten) ||
          forgotten.length > MAX_FORGOTTEN_SOURCES ||
          !forgotten.every(
            (value) => typeof value === "string" && value.length <= MAX_SOURCE_ID_CHARS,
          )
        ) {
          throw new Error("invalid ledger");
        }
        return { current: current as Record<string, string>, forgotten } satisfies SourceLedger;
      },
      catch: () => new Error("Memory source ledger is unreadable; cited writes are paused."),
    });
  });
}

function writeLedger(
  fs: FileSystem.FileSystem,
  root: string,
  ledger: SourceLedger,
): Effect.Effect<void, Error> {
  if (ledger.forgotten.length > MAX_FORGOTTEN_SOURCES) {
    return Effect.fail(
      new Error("Memory source ledger is full; cannot safely forget more sources."),
    );
  }
  if (Object.keys(ledger.current).length > MAX_TRACKED_PATHS) {
    return Effect.fail(new Error("Memory source ledger has too many tracked paths."));
  }
  return writeFileStringAtomic(fs, ledgerPath(root), `${JSON.stringify(ledger)}\n`, {
    tempPrefix: "memory-source-ledger",
  });
}

/**
 * Reserve a source for a file update. Superseding an earlier source revokes it
 * before the content changes, so compaction cannot restore the old claim.
 */
export function prepareMemorySourceWrite(
  fs: FileSystem.FileSystem,
  root: string,
  relativePath: string,
  sourceId: string | undefined,
): Effect.Effect<boolean, Error> {
  if (sourceId === undefined) return Effect.succeed(true);
  if (sourceId.length === 0 || sourceId.length > MAX_SOURCE_ID_CHARS) {
    return Effect.fail(new Error("Authenticated memory source ID is invalid."));
  }
  return Effect.gen(function* () {
    const ledger = yield* readLedger(fs, root);
    if (ledger.forgotten.includes(sourceId)) return false;
    const prior = ledger.current[relativePath];
    const forgotten =
      prior === undefined || prior === sourceId || ledger.forgotten.includes(prior)
        ? ledger.forgotten
        : [...ledger.forgotten, prior];
    yield* writeLedger(fs, root, {
      current: Object.assign(Object.create(null) as Record<string, string>, ledger.current, {
        [relativePath]: sourceId,
      }),
      forgotten,
    });
    return true;
  });
}

/** Revoke the original sources before deleting a file or directory. */
export function prepareMemorySourceDelete(
  fs: FileSystem.FileSystem,
  root: string,
  relativePath: string,
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const ledger = yield* readLedger(fs, root);
    const current = Object.assign(Object.create(null) as Record<string, string>, ledger.current);
    const forgotten = new Set(ledger.forgotten);
    let changed = false;
    for (const [path, sourceId] of Object.entries(current)) {
      if (path !== relativePath && !path.startsWith(`${relativePath}/`)) continue;
      forgotten.add(sourceId);
      delete current[path];
      changed = true;
    }
    if (changed) yield* writeLedger(fs, root, { current, forgotten: [...forgotten] });
  });
}

/**
 * Preserve source tracking at the destination before a rename. Keeping the
 * original mapping until a later mutation also covers a failed filesystem move.
 */
export function prepareMemorySourceRename(
  fs: FileSystem.FileSystem,
  root: string,
  fromPath: string,
  toPath: string,
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const ledger = yield* readLedger(fs, root);
    const current = Object.assign(Object.create(null) as Record<string, string>, ledger.current);
    let changed = false;
    for (const [path, sourceId] of Object.entries(ledger.current)) {
      if (path !== fromPath && !path.startsWith(`${fromPath}/`)) continue;
      current[`${toPath}${path.slice(fromPath.length)}`] = sourceId;
      changed = true;
    }
    if (changed) yield* writeLedger(fs, root, { current, forgotten: ledger.forgotten });
  });
}
