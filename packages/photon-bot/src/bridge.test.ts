import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  agentIdForSpace,
  allowListPath,
  credentialsPath,
  readSavedAllowList,
  readSavedCredentials,
  saveAllowList,
  promptFrom,
  saveCredentials,
} from "./bridge";

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

describe("saved credentials", () => {
  test("round-trip, and the file is not readable by anyone else", () => {
    const home = mkdtempSync(join(tmpdir(), "jazz-photon-creds-"));
    saveCredentials(home, { projectId: "abc", projectSecret: "shh" });

    expect(readSavedCredentials(home)).toEqual({ projectId: "abc", projectSecret: "shh" });
    // The secret can send as your line, so it is no more readable than an API key.
    expect(statSync(credentialsPath(home)).mode & 0o077).toBe(0);
  });

  test("a half-written file is no credentials at all, not a broken login", () => {
    const home = mkdtempSync(join(tmpdir(), "jazz-photon-half-"));
    writeFileSync(credentialsPath(home), JSON.stringify({ projectId: "abc" }));
    expect(readSavedCredentials(home)).toBeUndefined();
  });

  test("an unanswered home reads as none rather than throwing", () => {
    expect(readSavedCredentials(mkdtempSync(join(tmpdir(), "jazz-photon-none-")))).toBeUndefined();
  });
});

describe("promptFrom", () => {
  const home = (): string => mkdtempSync(join(tmpdir(), "jazz-photon-media-"));

  test("passes text straight through", async () => {
    expect(await promptFrom({ id: "m1", content: { type: "text", text: " hi " } }, home())).toBe(
      "hi",
    );
  });

  test("writes an attachment to disk and hands over the path, since Jazz ingests by path", async () => {
    const dataDir = home();
    const prompt = await promptFrom(
      {
        id: "m2",
        content: {
          type: "attachment",
          name: "receipt.pdf",
          mimeType: "application/pdf",
          read: () => Promise.resolve(Buffer.from("%PDF-1.4")),
        },
      },
      dataDir,
    );

    expect(prompt).toBe(join(dataDir, "ph-media", "m2.pdf"));
    expect(readFileSync(prompt, "utf8")).toBe("%PDF-1.4");
  });

  test("names a voice note by its mime type when it arrives without one", async () => {
    const dataDir = home();
    const prompt = await promptFrom(
      {
        id: "m3",
        content: {
          type: "voice",
          mimeType: "audio/m4a",
          read: () => Promise.resolve(Buffer.from("bytes")),
        },
      },
      dataDir,
    );

    expect(prompt).toBe(join(dataDir, "ph-media", "m3.m4a"));
  });

  test("a download that fails loses the attachment, not the message", async () => {
    const prompt = await promptFrom(
      {
        id: "m4",
        content: {
          type: "attachment",
          name: "x.png",
          mimeType: "image/png",
          read: () => Promise.reject(new Error("gone")),
        },
      },
      home(),
    );
    expect(prompt).toBe("");
  });

  test("a reaction carries nothing to answer", async () => {
    expect(await promptFrom({ id: "m5", content: { type: "reaction" } }, home())).toBe("");
  });
});
