/**
 * Append-only JSONL files with a size cap, for local measurement logs (memory recall,
 * tool misfires) whose value is the recent past rather than a complete record.
 *
 * `appendBoundedJsonlLine` appends one line and, once the file would pass `maxBytes`, first
 * renames it to `<file>.1` (replacing the previous `.1`), so the pair never holds more than
 * twice the cap. A file whose last write was cut off mid-line gets a newline first, so a crash
 * costs the interrupted entry and not the one after it.
 *
 * `readJsonlNewestFirst` reads backwards from the end of the current file, and then of `.1`,
 * a chunk at a time, stopping at `limit` entries or `maxBytes` read, so a reader asking for
 * the latest few entries never loads the whole file.
 */
import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import { stateDirectoryMode, stateFileMode } from "./private-mode";

/** Bytes read per step while scanning a file backwards. */
const READ_CHUNK_BYTES = 64 * 1024;

/** Path of the rotated generation of a bounded JSONL file. */
export function rotatedJsonlPath(filePath: string): string {
  return `${filePath}.1`;
}

async function fileSize(filePath: string): Promise<number | null> {
  try {
    return (await nodeFs.stat(filePath)).size;
  } catch {
    return null;
  }
}

async function endsMidLine(filePath: string, size: number): Promise<boolean> {
  if (size === 0) {
    return false;
  }
  let handle: nodeFs.FileHandle | undefined;
  try {
    handle = await nodeFs.open(filePath, "r");
    const tail = Buffer.alloc(1);
    await handle.read(tail, 0, 1, size - 1);
    return tail.toString("utf-8") !== "\n";
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Appends `line` (one serialized entry, without its newline), rotating first when full. */
export async function appendBoundedJsonlLine(
  filePath: string,
  line: string,
  options: { readonly maxBytes: number },
): Promise<void> {
  await nodeFs.mkdir(path.dirname(filePath), {
    recursive: true,
    mode: stateDirectoryMode(),
  });
  const record = `${line}\n`;
  let size = await fileSize(filePath);
  if (size !== null && size + Buffer.byteLength(record) > options.maxBytes) {
    await nodeFs.rename(filePath, rotatedJsonlPath(filePath));
    size = null;
  }
  const prefix = size !== null && (await endsMidLine(filePath, size)) ? "\n" : "";
  await nodeFs.appendFile(filePath, `${prefix}${record}`, {
    encoding: "utf-8",
    mode: stateFileMode(),
  });
}

/**
 * Complete lines of one file, newest first, reading at most `budgetBytes` from its end.
 * `visit` returns false to stop early.
 */
async function visitLinesBackwards(
  filePath: string,
  budgetBytes: number,
  visit: (line: string) => boolean,
): Promise<{ readonly bytesRead: number; readonly stopped: boolean }> {
  let handle: nodeFs.FileHandle | undefined;
  try {
    handle = await nodeFs.open(filePath, "r");
  } catch {
    return { bytesRead: 0, stopped: false };
  }
  try {
    const { size } = await handle.stat();
    let position = size;
    let bytesRead = 0;
    let carry = Buffer.alloc(0);
    while (position > 0 && bytesRead < budgetBytes) {
      const length = Math.min(READ_CHUNK_BYTES, position, budgetBytes - bytesRead);
      position -= length;
      const chunk = Buffer.alloc(length);
      await handle.read(chunk, 0, length, position);
      bytesRead += length;
      const combined = Buffer.concat([chunk, carry]);
      const text = combined.toString("utf-8");
      const firstNewline = combined.indexOf(0x0a);
      if (firstNewline === -1 && position > 0) {
        carry = combined;
        continue;
      }
      const splitAt = position > 0 ? firstNewline : -1;
      carry = splitAt === -1 ? Buffer.alloc(0) : combined.subarray(0, splitAt);
      const complete = splitAt === -1 ? text : combined.subarray(splitAt + 1).toString("utf-8");
      const lines = complete.split("\n");
      for (let index = lines.length - 1; index >= 0; index--) {
        const lineText = lines[index] ?? "";
        if (lineText.trim().length === 0) {
          continue;
        }
        if (!visit(lineText)) {
          return { bytesRead, stopped: true };
        }
      }
    }
    return { bytesRead, stopped: false };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Entries newest first from the file and then its rotated generation. `parse` returns
 * undefined for a line to skip (unreadable, or filtered out).
 */
export async function readJsonlNewestFirst<Entry>(
  filePath: string,
  options: {
    readonly parse: (line: string) => Entry | undefined;
    readonly limit?: number | undefined;
    readonly maxBytes: number;
  },
): Promise<Entry[]> {
  const entries: Entry[] = [];
  const visit = (line: string): boolean => {
    const entry = options.parse(line);
    if (entry !== undefined) {
      entries.push(entry);
    }
    return options.limit === undefined || entries.length < options.limit;
  };
  const current = await visitLinesBackwards(filePath, options.maxBytes, visit);
  if (current.stopped || current.bytesRead >= options.maxBytes) {
    return entries;
  }
  await visitLinesBackwards(
    rotatedJsonlPath(filePath),
    options.maxBytes - current.bytesRead,
    visit,
  );
  return entries;
}
