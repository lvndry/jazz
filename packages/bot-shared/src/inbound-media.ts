/**
 * @fileoverview Keeping an attachment someone sent, inside their conversation's home.
 *
 * Jazz ingests media by path, so a bridge's job with an inbound voice note or photo ends at
 * "file on disk". That file goes into a home the conversation's uid controls while the
 * bridge writes as root, so the directory is pinned and the write never follows a link
 * (`sandbox-fs.ts`), and the file is handed to the conversation as it is written.
 *
 * Old media is pruned on every save. Every voice note ever sent would otherwise stay on the
 * host; a day is long enough that a path mentioned earlier in a live conversation still
 * resolves, and Jazz degrades an unreadable attachment to a text note, so an expired file is
 * not a crash.
 */

import { join } from "node:path";
import { type Ownership, type PinnedDirectory, withDirectory } from "./sandbox-fs";

/** Files older than this are deleted on the next save. */
const MEDIA_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Modes for media the bridge keeps in its own data directory. */
const DEFAULT_DIRECTORY_MODE = 0o750;
const DEFAULT_FILE_MODE = 0o640;

function pruneMedia(directory: PinnedDirectory, nowMs: number): void {
  let entries: string[];
  try {
    entries = directory.list();
  } catch {
    return;
  }
  for (const entry of entries) {
    try {
      const modifiedAt = directory.modifiedAt(entry);
      if (modifiedAt !== undefined && nowMs - modifiedAt > MEDIA_RETENTION_MS) {
        directory.remove(entry);
      }
    } catch {
      // A file vanishing mid-prune is fine; anything else is not worth failing a save over.
    }
  }
}

/**
 * Write `bytes` as `<home>/<directoryName>/<fileName>` and return that absolute path, which
 * is what goes into the prompt. `fileName` must already be a plain segment
 * (`media-name.ts`).
 */
export function saveInboundMedia(options: {
  readonly home: string;
  readonly directoryName: string;
  readonly fileName: string;
  readonly bytes: Uint8Array;
  readonly ownership: Ownership | undefined;
  readonly nowMs: number;
}): string {
  const { ownership } = options;
  withDirectory(options.home, {}, (home) => {
    const media = home.directory(options.directoryName, {
      create: {
        owner: ownership?.owner,
        mode: ownership?.directoryMode ?? DEFAULT_DIRECTORY_MODE,
      },
    });
    try {
      pruneMedia(media, options.nowMs);
      media.writeBytes(options.fileName, options.bytes, {
        owner: ownership?.owner,
        mode: ownership?.fileMode ?? DEFAULT_FILE_MODE,
      });
    } finally {
      media.close();
    }
  });
  return join(options.home, options.directoryName, options.fileName);
}
