import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { z } from "zod";
import {
  CorruptStateFileError,
  NewerStateFileError,
  readStateFile,
  recordListKind,
  writeStateFile,
} from "./state-file";

const NOTE_KIND = recordListKind("notes", "notes", z.object({ id: z.string() }));

function tempFile(): { readonly directory: string; readonly file: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-state-file-"));
  return { directory, file: path.join(directory, "notes.json") };
}

describe("state files", () => {
  test("round-trips records under a schema version", async () => {
    const { file } = tempFile();
    await Effect.runPromise(writeStateFile(file, NOTE_KIND, [{ id: "a" }]));
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      schemaVersion: 1,
      notes: [{ id: "a" }],
    });
    const read = await Effect.runPromise(readStateFile(file, NOTE_KIND, { onCorrupt: "fail" }));
    expect(read).toEqual([{ id: "a" }]);
  });

  test("reads a file written before schema versions", async () => {
    const { file } = tempFile();
    fs.writeFileSync(file, JSON.stringify([{ id: "legacy" }]));
    const read = await Effect.runPromise(readStateFile(file, NOTE_KIND, { onCorrupt: "fail" }));
    expect(read).toEqual([{ id: "legacy" }]);
  });

  test("refuses a file from a newer Jazz and leaves it untouched", async () => {
    const { file } = tempFile();
    const newer = JSON.stringify({ schemaVersion: 2, notes: [] });
    fs.writeFileSync(file, newer);
    const error = await Effect.runPromise(
      readStateFile(file, NOTE_KIND, { onCorrupt: "quarantine" }).pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(NewerStateFileError);
    expect(fs.readFileSync(file, "utf8")).toBe(newer);
  });

  test("reports corruption without moving the file when asked to fail", async () => {
    const { file } = tempFile();
    fs.writeFileSync(file, "{torn");
    const error = await Effect.runPromise(
      readStateFile(file, NOTE_KIND, { onCorrupt: "fail" }).pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(CorruptStateFileError);
    expect(fs.readFileSync(file, "utf8")).toBe("{torn");
  });

  test("quarantines a file with an invalid record instead of dropping the record", async () => {
    const { directory, file } = tempFile();
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, notes: [{ id: "a" }, { id: 7 }] }));
    const read = await Effect.runPromise(
      readStateFile(file, NOTE_KIND, { onCorrupt: "quarantine" }),
    );
    expect(read).toBeUndefined();
    const aside = fs.readdirSync(directory).filter((name) => name.includes(".corrupt-"));
    expect(aside).toHaveLength(1);
  });
});
