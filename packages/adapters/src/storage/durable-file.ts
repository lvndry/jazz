/**
 * Replace a JSON document so that a crash leaves either the old version or the new one on
 * disk, never a torn file a reader would misparse as missing or corrupt.
 */

import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import * as path from "node:path";

/**
 * Write `value` to an exclusively created sibling temporary file (mode 0600), flush it, rename
 * it over `destination`, and flush the directory so the rename itself survives a crash. The
 * parent directory is created with mode 0700 when missing.
 */
export async function writeJsonFileDurably(destination: string, value: unknown): Promise<void> {
  const directory = path.dirname(destination);
  await nodeFs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(destination)}-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    const handle = await nodeFs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await nodeFs.rename(temporary, destination);
    await nodeFs.chmod(destination, 0o600);
    const directoryHandle = await nodeFs.open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    await nodeFs.rm(temporary, { force: true }).catch(() => undefined);
  }
}
