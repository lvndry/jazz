/**
 * Versioned JSON state files: wake triggers, reminders, job batches and run history.
 *
 * Every such file carries a top-level `schemaVersion`. Reading one has four outcomes:
 * - absent: the store is empty;
 * - readable at a known version: its validated content;
 * - written by a newer Jazz (`schemaVersion` above the current one): refused with
 *   {@link NewerStateFileError}, and left untouched, so an older binary never rewrites a format
 *   it does not understand;
 * - unreadable (torn JSON, wrong shape, invalid records): {@link CorruptStateFileError}, or,
 *   with `onCorrupt: "quarantine"`, the file is renamed aside with a warning and the store reads
 *   as empty, so the next write starts a fresh file instead of overwriting the damaged one.
 *
 * Quarantine belongs inside the store's lock: an unlocked reader that moved a file aside could
 * race a locked writer and move away the good file that writer just put in place. Unlocked
 * readers use `onCorrupt: "fail"`.
 *
 * A file with no `schemaVersion` predates versioning; the kind's `parse` receives it with
 * `schemaVersion` undefined and migrates it, and the next write stores it versioned.
 */

import * as nodeFs from "node:fs/promises";
import { Effect } from "effect";
import type { z } from "zod";
import { toError } from "@/core/utils/errors";
import { isRecord } from "@/core/utils/is-record";
import { quarantineCorruptFile, writeFileStringAtomic } from "@/core/utils/storage";

export type StateFileParse<Content> =
  { readonly ok: true; readonly content: Content } | { readonly ok: false; readonly error: string };

/** What the shared reader and writer need to know about one kind of state file. */
export interface StateFileKind<Content> {
  /** Plural description for messages ("wake triggers", "job batch"). */
  readonly noun: string;
  /** The version this build writes, and the newest it reads. */
  readonly schemaVersion: number;
  /**
   * Validate a parsed document. `schemaVersion` is the file's version, or undefined for a file
   * written before versioning, which `parse` migrates when it can.
   */
  readonly parse: (document: unknown, schemaVersion: number | undefined) => StateFileParse<Content>;
  /** The document to store for `content`, without `schemaVersion` (the writer stamps it). */
  readonly serialize: (content: Content) => Record<string, unknown>;
}

export interface StateFileReadOptions {
  readonly onCorrupt: "quarantine" | "fail";
}

/** A state file whose `schemaVersion` is newer than this build understands. */
export class NewerStateFileError extends Error {
  constructor(
    readonly filePath: string,
    readonly schemaVersion: number,
    readonly supportedVersion: number,
  ) {
    super(
      `${filePath} was written by a newer version of Jazz (schema ${schemaVersion}; this version reads up to ${supportedVersion}). Update Jazz to use it.`,
    );
    this.name = "NewerStateFileError";
  }
}

/** A state file that exists but cannot be read as its kind. */
export class CorruptStateFileError extends Error {
  constructor(
    readonly filePath: string,
    readonly reason: string,
  ) {
    super(`${filePath} is unreadable: ${reason}`);
    this.name = "CorruptStateFileError";
  }
}

type Decoded<Content> =
  | { readonly status: "ok"; readonly content: Content }
  | { readonly status: "corrupt"; readonly reason: string };

function decode<Content>(
  raw: string,
  filePath: string,
  kind: StateFileKind<Content>,
): Effect.Effect<Decoded<Content>, NewerStateFileError> {
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    return Effect.succeed({
      status: "corrupt",
      reason: `invalid JSON (${toError(error).message})`,
    });
  }
  const version =
    isRecord(document) && document["schemaVersion"] !== undefined
      ? document["schemaVersion"]
      : undefined;
  if (version !== undefined && (!Number.isSafeInteger(version) || (version as number) < 1)) {
    return Effect.succeed({ status: "corrupt", reason: "invalid schemaVersion" });
  }
  if (typeof version === "number" && version > kind.schemaVersion) {
    return Effect.fail(new NewerStateFileError(filePath, version, kind.schemaVersion));
  }
  const parsed = kind.parse(document, version as number | undefined);
  return Effect.succeed(
    parsed.ok
      ? { status: "ok", content: parsed.content }
      : { status: "corrupt", reason: parsed.error },
  );
}

/**
 * Read a state file. Resolves to undefined when the file is absent, or when it was corrupt and
 * has been quarantined.
 */
export function readStateFile<Content>(
  filePath: string,
  kind: StateFileKind<Content>,
  options: StateFileReadOptions,
): Effect.Effect<Content | undefined, Error> {
  return Effect.gen(function* () {
    const raw = yield* Effect.tryPromise({
      try: async () => {
        try {
          return await nodeFs.readFile(filePath, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
          }
          throw error;
        }
      },
      catch: toError,
    });
    if (raw === undefined) {
      return undefined;
    }
    const decoded = yield* decode(raw, filePath, kind);
    if (decoded.status === "ok") {
      return decoded.content;
    }
    if (options.onCorrupt === "fail") {
      return yield* Effect.fail(new CorruptStateFileError(filePath, decoded.reason));
    }
    yield* quarantineCorruptFile(filePath, `${kind.noun}: ${decoded.reason}`);
    return undefined;
  });
}

/** Durably replace a state file with `content`, stamped with the kind's `schemaVersion`. */
export function writeStateFile<Content>(
  filePath: string,
  kind: StateFileKind<Content>,
  content: Content,
): Effect.Effect<void, Error> {
  const document = { schemaVersion: kind.schemaVersion, ...kind.serialize(content) };
  return writeFileStringAtomic(filePath, `${JSON.stringify(document, null, 2)}\n`);
}

/**
 * A state file holding one list of records under `field` (`{ schemaVersion, triggers: [...] }`).
 * A file written before versioning is a bare array of the same records. Every record is
 * validated against `recordSchema`; one invalid record makes the whole file unreadable rather
 * than silently dropping it.
 */
export function recordListKind<Rec>(
  noun: string,
  field: string,
  recordSchema: z.ZodType<Rec>,
): StateFileKind<Rec[]> {
  return {
    noun,
    schemaVersion: 1,
    parse: (document, schemaVersion) => {
      const list =
        schemaVersion === undefined && Array.isArray(document)
          ? document
          : isRecord(document)
            ? document[field]
            : undefined;
      if (!Array.isArray(list)) {
        return { ok: false, error: `expected a list of ${noun}` };
      }
      const records: Rec[] = [];
      for (const [index, entry] of list.entries()) {
        const parsed = recordSchema.safeParse(entry);
        if (!parsed.success) {
          return { ok: false, error: `entry ${index}: ${parsed.error.message}` };
        }
        records.push(parsed.data);
      }
      return { ok: true, content: records };
    },
    serialize: (records) => ({ [field]: records }),
  };
}
