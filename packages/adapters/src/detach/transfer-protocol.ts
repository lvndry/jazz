/**
 * Streams a detach snapshot over an authenticated SSH stdin channel.
 *
 * The protocol sends length-framed regular files, never tar metadata or shell paths. The
 * receiver writes into a fresh staging directory and verifies every payload before it can be
 * imported. Callers still validate the snapshot manifest through `importDetachSnapshot`.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";

/**
 * Helper protocol a remote Jazz must speak before a handoff starts. Bumped whenever a
 * `jazz detach _*` helper is added or changes shape.
 */
export const DETACH_PROTOCOL = "jazz-detach-2";
const MAGIC = "JAZZ-DETACH-1\n";
const MAX_HEADER_BYTES = 8 * 1024;
const MAX_FILES = 100_000;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;

interface FileHeader {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

function validRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !path.posix.isAbsolute(value) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

async function* regularFiles(root: string, prefix = ""): AsyncGenerator<string> {
  for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!validRelativePath(relative)) {
      throw new Error("Unsafe detach bundle path");
    }
    if (entry.isDirectory()) {
      yield* regularFiles(root, relative);
    } else if (entry.isFile()) {
      yield relative;
    } else {
      throw new Error(`Detach bundle contains a non-regular file: ${relative}`);
    }
  }
}

async function describeFile(filePath: string, relative: string): Promise<FileHeader> {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.size > MAX_BYTES) {
    throw new Error(`Invalid bundle file: ${relative}`);
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return { path: relative, size: stat.size, sha256: hash.digest("hex") };
}

/** Produces a bounded-memory stream from a snapshot directory. */
export function encodeDetachBundle(bundleDirectory: string): Readable {
  return Readable.from(
    (async function* (): AsyncGenerator<Buffer> {
      yield Buffer.from(MAGIC);
      let count = 0;
      let total = 0;
      for await (const relative of regularFiles(bundleDirectory)) {
        if (++count > MAX_FILES) {
          throw new Error("Detach bundle has too many files");
        }
        const filePath = path.join(bundleDirectory, relative);
        const header = await describeFile(filePath, relative);
        total += header.size;
        if (total > MAX_BYTES) {
          throw new Error("Detach bundle is too large");
        }
        yield Buffer.from(`${JSON.stringify(header)}\n`);
        for await (const chunk of createReadStream(filePath)) {
          yield chunk as Buffer;
        }
      }
      yield Buffer.from("END\n");
    })(),
  );
}

class ByteReader {
  private readonly source: AsyncIterator<Buffer>;
  private pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  constructor(stream: Readable) {
    this.source = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }

  private async refill(): Promise<void> {
    if (this.pending.length > 0) {
      return;
    }
    const next = await this.source.next();
    if (next.done) {
      throw new Error("Truncated detach bundle");
    }
    this.pending = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
  }

  async line(): Promise<string> {
    const chunks: Buffer[] = [];
    let length = 0;
    for (;;) {
      await this.refill();
      const newline = this.pending.indexOf(10);
      const take = newline < 0 ? this.pending.length : newline;
      if (take > 0) {
        chunks.push(this.pending.subarray(0, take));
      }
      length += take;
      if (length > MAX_HEADER_BYTES) {
        throw new Error("Detach bundle header is too large");
      }
      this.pending = this.pending.subarray(take + (newline < 0 ? 0 : 1));
      if (newline >= 0) {
        return Buffer.concat(chunks).toString("utf8");
      }
    }
  }

  async file(filePath: string, size: number, expectedHash: string): Promise<void> {
    const handle = await fs.open(filePath, "wx", 0o600);
    const hash = createHash("sha256");
    let left = size;
    try {
      while (left > 0) {
        await this.refill();
        const take = Math.min(left, this.pending.length);
        const chunk = this.pending.subarray(0, take);
        await handle.write(chunk);
        hash.update(chunk);
        this.pending = this.pending.subarray(take);
        left -= take;
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (hash.digest("hex") !== expectedHash) {
      throw new Error("Detach bundle checksum mismatch");
    }
  }
}

/** Receives a stream into an empty directory, rejecting unsafe or corrupted entries. */
export async function receiveDetachBundle(stream: Readable, destination: string): Promise<void> {
  const reader = new ByteReader(stream);
  if ((await reader.line()) !== MAGIC.trimEnd()) {
    throw new Error("Invalid detach bundle header");
  }
  await fs.mkdir(destination, { recursive: false, mode: 0o700 });
  let count = 0;
  let total = 0;
  const seen = new Set<string>();
  for (;;) {
    const line = await reader.line();
    if (line === "END") {
      break;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error("Invalid detach bundle entry");
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("Invalid bundle entry");
    }
    const entry = parsed as Partial<FileHeader>;
    if (
      typeof entry.path !== "string" ||
      !validRelativePath(entry.path) ||
      typeof entry.size !== "number" ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      seen.has(entry.path)
    ) {
      throw new Error("Invalid or duplicate detach bundle entry");
    }
    seen.add(entry.path);
    if (++count > MAX_FILES || (total += entry.size) > MAX_BYTES) {
      throw new Error("Detach bundle exceeds limits");
    }
    const target = path.join(destination, entry.path);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await reader.file(target, entry.size, entry.sha256);
  }
  if (!seen.has("manifest.json")) {
    throw new Error("Detach bundle has no manifest");
  }
}
