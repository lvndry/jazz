import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { recordClaimSentences } from "./memory-source-ledger";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

let directory: string;

function recordClaim(relativePath: string, sentenceKeys: readonly string[]) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* recordClaimSentences(fs, directory, relativePath, sentenceKeys);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "jazz-ledger-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("the memory source ledger on disk", () => {
  it("stamps the ledger with a schema version on save", async () => {
    await recordClaim("notes.md", [KEY_A]);
    const ledger = JSON.parse(await readFile(path.join(directory, ".source-ledger.json"), "utf8"));
    expect(ledger.schemaVersion).toBe(1);
    expect(ledger.sentenceKeysByPath).toEqual({ "notes.md": [KEY_A] });
  });

  it("reads a ledger written before versioning and re-stamps it on the next write", async () => {
    await writeFile(
      path.join(directory, ".source-ledger.json"),
      JSON.stringify({
        sentenceKeysByPath: { "notes.md": [KEY_A] },
        revokedSentenceKeys: [KEY_B],
      }),
    );
    // a revoked sentence blocks the cited write, proving the legacy ledger was read
    expect(await recordClaim("other.md", [KEY_B])).toBe(false);
    expect(await recordClaim("other.md", [KEY_A])).toBe(true);
    const ledger = JSON.parse(await readFile(path.join(directory, ".source-ledger.json"), "utf8"));
    expect(ledger.schemaVersion).toBe(1);
  });
});
