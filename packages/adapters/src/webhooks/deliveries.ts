/**
 * @fileoverview The deliveries each webhook has already run, so a replayed request runs nothing.
 *
 * A signature proves a body came from the sender, not that it is the first time it arrived:
 * anyone who captured one signed request can send it again. So every fire first claims its
 * delivery keys here, and a fire whose key is already claimed is refused. Two keys are claimed:
 *
 * - the sender's delivery id (`X-GitHub-Delivery`, or the webhook's `deliveryIdHeader`), when the
 *   request carries one, and
 * - the body's signature, when the webhook is signed. GitHub does not sign its delivery id, so a
 *   replay under a fresh id would otherwise pass. The signature is an HMAC of the exact body, so
 *   claiming it makes a captured request unreplayable under any id.
 *
 * The record is bounded: each webhook keeps its {@link MAX_REMEMBERED_DELIVERIES} most recent
 * keys, and the oldest are forgotten first. It lives on disk, so a restart does not reopen the
 * window. A claim holds the file lock across read and write, so two concurrent copies of one
 * delivery cannot both be fresh.
 */

import path from "node:path";
import { FileSystem } from "@effect/platform";
import { toError } from "@jazz/core/utils/errors";
import { getWebhookDeliveriesDirectory } from "@jazz/core/utils/paths";
import { decodeStateFile, encodeStateFile, type StateFileKind } from "@jazz/core/utils/state-file";
import { withLock, writeFileStringAtomic } from "@jazz/core/utils/storage";
import { storageSafeSegment } from "@jazz/core/utils/storage-id";
import { Effect } from "effect";

/**
 * How many delivery keys each webhook remembers.
 *
 * A fire claims at most two keys, so this is at least 500 recent deliveries: days of traffic for
 * a busy repository, while the file stays a few tens of kilobytes.
 */
export const MAX_REMEMBERED_DELIVERIES = 1000;

export type DeliveryClaim = "fresh" | "duplicate";

/**
 * On-disk shape of one webhook's claim file: the delivery keys stamped with a `schemaVersion`
 * so a future format change can migrate instead of guessing. A file written before versioning
 * is a bare array, which `parse` reads unchanged; the next write stores it stamped. The keys
 * are nested under `keys` because the envelope is an object, and the record is a list.
 */
const DELIVERIES_KIND: StateFileKind<readonly string[]> = {
  noun: "delivery keys",
  schemaVersion: 1,
  parse: (document) => {
    const raw = Array.isArray(document) ? document : (document as { keys?: unknown }).keys;
    const keys = Array.isArray(raw)
      ? raw.filter((key): key is string => typeof key === "string")
      : [];
    return { ok: true, content: keys };
  },
  serialize: (keys) => ({ keys: [...keys] }),
};
function ledgerPath(directory: string, webhookName: string): string {
  return path.join(directory, `${storageSafeSegment(webhookName)}.json`);
}

function readClaimed(fs: FileSystem.FileSystem, filePath: string) {
  return fs.readFileString(filePath).pipe(
    Effect.map((raw): readonly string[] => {
      const decoded = decodeStateFile(raw, "delivery claim file", DELIVERIES_KIND);
      return decoded.status === "ok" ? decoded.content : [];
    }),
    Effect.catchAll(() => Effect.succeed<readonly string[]>([])),
  );
}

/**
 * Claim every key of one delivery, or report that one of them was already claimed.
 *
 * All or nothing: a duplicate claims none of its keys, so the record only ever holds deliveries
 * that ran.
 */
export function claimDelivery(
  webhookName: string,
  keys: readonly string[],
  directory: string = getWebhookDeliveriesDirectory(),
): Effect.Effect<DeliveryClaim, Error, FileSystem.FileSystem> {
  if (keys.length === 0) {
    return Effect.succeed("fresh");
  }
  const filePath = ledgerPath(directory, webhookName);
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs
      .makeDirectory(directory, { recursive: true, mode: DELIVERIES_DIRECTORY_MODE })
      .pipe(Effect.mapError(toError));
    return yield* withLock(`${filePath}.lock`, claimUnderLock(fs, filePath, keys));
  });
}

/** Owner-only, since the record says which deliveries reached this machine. */
const DELIVERIES_DIRECTORY_MODE = 0o700;
const DELIVERIES_FILE_MODE = 0o600;

function claimUnderLock(fs: FileSystem.FileSystem, filePath: string, keys: readonly string[]) {
  return Effect.gen(function* () {
    const claimed = yield* readClaimed(fs, filePath);
    const known = new Set(claimed);
    if (keys.some((key) => known.has(key))) {
      return "duplicate" as const;
    }
    const kept = [...claimed, ...keys].slice(-MAX_REMEMBERED_DELIVERIES);
    yield* writeFileStringAtomic(filePath, encodeStateFile(DELIVERIES_KIND, kept), {
      mode: DELIVERIES_FILE_MODE,
    });
    return "fresh" as const;
  });
}
