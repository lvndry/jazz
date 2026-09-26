/** Failure-focused checks for the SSH snapshot stream's path and checksum boundary. */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { afterEach, expect, test } from "bun:test";
import { encodeDetachBundle, receiveDetachBundle } from "./transfer-protocol";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function tempDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-detach-stream-"));
  directories.push(directory);
  return directory;
}

test("streams files into a fresh directory with their bytes intact", async () => {
  const base = await tempDirectory();
  const source = path.join(base, "source");
  const destination = path.join(base, "destination");
  await fs.mkdir(path.join(source, "files", "workspace"), { recursive: true });
  await fs.writeFile(path.join(source, "manifest.json"), '{"version":1}\n');
  await fs.writeFile(
    path.join(source, "files", "workspace", "binary.bin"),
    Buffer.from([0, 10, 255, 42]),
  );
  await receiveDetachBundle(encodeDetachBundle(source), destination);
  expect(await fs.readFile(path.join(destination, "files", "workspace", "binary.bin"))).toEqual(
    Buffer.from([0, 10, 255, 42]),
  );
});

test("rejects path traversal before writing outside staging", async () => {
  const base = await tempDirectory();
  const payload = Buffer.from(
    'JAZZ-DETACH-1\n{"path":"../escape","size":0,"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}\nEND\n',
  );
  await expect(
    receiveDetachBundle(Readable.from([payload]), path.join(base, "received")),
  ).rejects.toThrow("Invalid or duplicate");
  expect(await fs.lstat(path.join(base, "escape")).catch(() => undefined)).toBeUndefined();
});

test("rejects a corrupted payload", async () => {
  const base = await tempDirectory();
  const payload = Buffer.from(
    'JAZZ-DETACH-1\n{"path":"manifest.json","size":1,"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}\nXEND\n',
  );
  await expect(
    receiveDetachBundle(Readable.from([payload]), path.join(base, "received")),
  ).rejects.toThrow("checksum mismatch");
});
