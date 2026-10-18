import { describe, expect, it } from "bun:test";
import { IncognitoTranscripts } from "./incognito-transcripts";

const HOUR_MS = 60 * 60 * 1000;

describe("IncognitoTranscripts", () => {
  it("starts a chat fresh once it has been idle past the TTL", () => {
    let nowMs = 0;
    const transcripts = new IncognitoTranscripts({ idleTtlMs: HOUR_MS, now: () => nowMs });
    transcripts.set("chat", ["hello"]);

    nowMs = HOUR_MS - 1;
    expect(transcripts.get("chat")).toEqual(["hello"]);
    nowMs = HOUR_MS * 2;
    expect(transcripts.get("chat")).toEqual([]);
    expect(transcripts.size).toBe(0);
  });

  it("drops idle chats when another chat takes a turn", () => {
    let nowMs = 0;
    const transcripts = new IncognitoTranscripts({ idleTtlMs: HOUR_MS, now: () => nowMs });
    transcripts.set("abandoned", ["old"]);

    nowMs = HOUR_MS * 2;
    transcripts.set("active", ["new"]);

    expect(transcripts.size).toBe(1);
    expect(transcripts.get("active")).toEqual(["new"]);
  });

  it("forgets the least recently used chat past the cap", () => {
    const transcripts = new IncognitoTranscripts({ maxChats: 2 });
    transcripts.set("first", ["one"]);
    transcripts.set("second", ["two"]);
    transcripts.set("first", ["one", "again"]);
    transcripts.set("third", ["three"]);

    expect(transcripts.size).toBe(2);
    expect(transcripts.get("second")).toEqual([]);
    expect(transcripts.get("first")).toEqual(["one", "again"]);
    expect(transcripts.get("third")).toEqual(["three"]);
  });
});
