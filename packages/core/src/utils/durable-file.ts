/**
 * Replace a file so that a crash leaves either the old version or the new one on disk, never a
 * torn or zero-length file a reader would misparse as missing or corrupt.
 *
 * Every whole-file replacement of Jazz state goes through `writeFileDurably` (directly, through
 * `writeJsonFileDurably`, or through the Effect wrapper `writeFileStringAtomic` in `storage.ts`).
 */

import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import { PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE } from "@/core/utils/private-mode";

export interface DurableWriteOptions {
  /** Mode of the new file. Jazz state is private to its owner unless a caller says otherwise. */
  readonly mode?: number;
}

/**
 * The owner a file created in `directory` should get when this process runs as root, or
 * undefined otherwise. A root process (a chat bridge sweeping a sandboxed conversation's home)
 * writing a private file into a directory another account owns would otherwise leave a file
 * that account can no longer read; giving it the directory's owner keeps the file usable by
 * whoever the directory belongs to.
 */
export async function parentOwnerWhenRoot(
  directory: string,
): Promise<{ readonly uid: number; readonly gid: number } | undefined> {
  if (process.getuid?.() !== 0) {
    return undefined;
  }
  const stats = await nodeFs.stat(directory);
  return stats.uid === 0 ? undefined : { uid: stats.uid, gid: stats.gid };
}

/**
 * Flush a directory so a rename in it survives a crash. Best effort: by now the new document is
 * in place, and reporting a failed write for a change that landed would be the worse error.
 */
async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await nodeFs.open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    return;
  }
}

/**
 * Write `content` to an exclusively created sibling temporary file, flush it, rename it over
 * `destination`, and flush the directory so the rename itself survives a crash. The parent
 * directory is created (mode 0700) when missing. The file is created with `options.mode`
 * (default 0600).
 */
export async function writeFileDurably(
  destination: string,
  content: string | Uint8Array,
  options: DurableWriteOptions = {},
): Promise<void> {
  const directory = path.dirname(destination);
  const mode = options.mode ?? PRIVATE_FILE_MODE;
  await nodeFs.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const temporary = path.join(
    directory,
    `.${path.basename(destination)}-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    const handle = await nodeFs.open(temporary, "wx", mode);
    try {
      const owner = await parentOwnerWhenRoot(directory);
      if (owner !== undefined) {
        await handle.chown(owner.uid, owner.gid);
      }
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await nodeFs.rename(temporary, destination);
    await syncDirectory(directory);
  } finally {
    await nodeFs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** {@link writeFileDurably} for a JSON document, pretty-printed with a trailing newline. */
export async function writeJsonFileDurably(
  destination: string,
  value: unknown,
  options: DurableWriteOptions = {},
): Promise<void> {
  await writeFileDurably(destination, `${JSON.stringify(value, null, 2)}\n`, options);
}
