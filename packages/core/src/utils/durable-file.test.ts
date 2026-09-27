import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { writeJsonFileDurably } from "./durable-file";

describe("writeJsonFileDurably", () => {
  it("replaces the document, private to its owner, and leaves no temporary file behind", async () => {
    const directory = join(mkdtempSync(join(tmpdir(), "durable-")), "nested");
    const destination = join(directory, "state.json");
    await writeJsonFileDurably(destination, { version: 1 });
    await writeJsonFileDurably(destination, { version: 2 });

    expect(JSON.parse(readFileSync(destination, "utf8"))).toEqual({ version: 2 });
    expect(statSync(destination).mode & 0o777).toBe(0o600);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(readdirSync(directory)).toEqual(["state.json"]);
  });
});
