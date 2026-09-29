import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { afterEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { describeFootprint, measureFootprint } from "./footprint";

const directories: string[] = [];

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "jazz-footprint-"));
  directories.push(directory);
  return directory;
}

function measure(target: string, limit?: number) {
  return Effect.runPromise(
    measureFootprint(target, limit).pipe(Effect.provide(NodeFileSystem.layer)),
  );
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("measureFootprint", () => {
  it("counts one file and its size", async () => {
    const file = join(scratch(), "note.txt");
    writeFileSync(file, "hello");
    expect(await measure(file)).toEqual({ files: 1, bytes: 5, truncated: false });
  });

  it("counts every file under a directory, nested ones included", async () => {
    const root = scratch();
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "a.txt"), "12345");
    writeFileSync(join(root, "nested", "b.txt"), "123");
    expect(await measure(root)).toEqual({ files: 2, bytes: 8, truncated: false });
  });

  it("stops at the entry limit and says the count is a floor", async () => {
    const root = scratch();
    for (const name of ["a", "b", "c"]) writeFileSync(join(root, name), "x");
    const footprint = await measure(root, 2);
    expect(footprint?.truncated).toBe(true);
    expect(footprint?.files).toBe(2);
  });

  it("is undefined for a path that does not exist", async () => {
    expect(await measure(join(scratch(), "missing"))).toBeUndefined();
  });
});

describe("describeFootprint", () => {
  it("reads as a count and a size", () => {
    expect(describeFootprint({ files: 1, bytes: 12_595, truncated: false })).toBe(
      "1 file, 12.3 KB",
    );
    expect(describeFootprint({ files: 214, bytes: 1_395_864_371, truncated: false })).toBe(
      "214 files, 1.3 GB",
    );
    expect(describeFootprint({ files: 10_000, bytes: 4_509_715_660, truncated: true })).toBe(
      "10,000+ files, 4.2 GB",
    );
  });
});
