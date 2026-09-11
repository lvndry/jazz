import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { agentIdForSpace, allowListPath, readSavedAllowList, saveAllowList } from "./bridge";

describe("agentIdForSpace", () => {
  test("is filename-safe, since the id becomes an agent file", () => {
    expect(agentIdForSpace("abc123")).toBe("ph_abc123");
    expect(agentIdForSpace("dm:+1 (555) 123/4567")).toBe("ph_dm__1__555__123_4567");
  });

  test("keeps one agent per space, so a chat's model survives", () => {
    expect(agentIdForSpace("s1")).toBe(agentIdForSpace("s1"));
    expect(agentIdForSpace("s1")).not.toBe(agentIdForSpace("s2"));
  });
});

describe("the saved allow-list", () => {
  test("round-trips as typed, so the file stays editable by hand", () => {
    const home = mkdtempSync(join(tmpdir(), "jazz-photon-"));
    saveAllowList(home, "+15551234567, +33123456789");

    expect(readSavedAllowList(home)).toBe("+15551234567, +33123456789");
    expect(JSON.parse(readFileSync(allowListPath(home), "utf8"))).toEqual({
      allowedHandles: "+15551234567, +33123456789",
    });
  });

  test("an unanswered home reads as empty rather than throwing", () => {
    expect(readSavedAllowList(mkdtempSync(join(tmpdir(), "jazz-photon-empty-")))).toBe("");
  });
});

test("importing the bridge exposes an entry point without starting one", async () => {
  const bridge = await import("./bridge");
  expect(typeof bridge.startBridge).toBe("function");
});
