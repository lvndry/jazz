import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

test("importing the bridge exposes an entry point without starting one", async () => {
  // The module used to call start() at import time, which is why there was no
  // `jazz whatsapp`: a CLI command could not load it to read anything out of it
  // without launching a linked device as a side effect.
  const bridge = await import("./bridge");
  expect(typeof bridge.startBridge).toBe("function");
});

test("saves an allow-list as typed, so the file stays editable by hand", async () => {
  const { saveAllowList, readSavedAllowList, allowListPath } = await import("./bridge");
  const home = mkdtempSync(join(tmpdir(), "jazz-wa-"));
  saveAllowList(home, "+15551234567, +33123456789");
  expect(readSavedAllowList(home)).toBe("+15551234567, +33123456789");
  expect(JSON.parse(readFileSync(allowListPath(home), "utf8"))).toEqual({
    allowedNumbers: "+15551234567, +33123456789",
  });
});

test("an unanswered home reads as no allow-list rather than throwing", async () => {
  const { readSavedAllowList } = await import("./bridge");
  expect(readSavedAllowList(mkdtempSync(join(tmpdir(), "jazz-wa-empty-")))).toBe("");
});
