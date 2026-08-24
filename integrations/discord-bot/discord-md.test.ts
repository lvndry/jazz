import { describe, expect, it } from "bun:test";
import {
  neutralizeBroadcastMentions,
  spoilerBlock,
  splitForDiscord,
  threadNameFromPrompt,
} from "./discord-md";

describe("splitForDiscord", () => {
  it("returns a placeholder for empty input", () => {
    expect(splitForDiscord("   ")).toEqual(["(empty response)"]);
  });

  it("keeps a short message whole", () => {
    expect(splitForDiscord("hello")).toEqual(["hello"]);
  });

  it("splits on a newline near the cap rather than mid-line", () => {
    const line = "x".repeat(100);
    const text = Array.from({ length: 25 }, () => line).join("\n");
    const chunks = splitForDiscord(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1900);
    }
  });
});

describe("neutralizeBroadcastMentions", () => {
  it("breaks @everyone and @here so they do not ping", () => {
    const out = neutralizeBroadcastMentions("hello @everyone and @here");
    expect(out).not.toContain("@everyone");
    expect(out).not.toContain("@here");
    expect(out).toContain("@\u200beveryone");
    expect(out).toContain("@\u200bhere");
  });
});

describe("threadNameFromPrompt", () => {
  it("prefixes Jazz and stays within Discord's 100-char cap", () => {
    const name = threadNameFromPrompt("a".repeat(200));
    expect(name.startsWith("Jazz · ")).toBe(true);
    expect(name.length).toBeLessThanOrEqual(100);
  });

  it("falls back when the prompt is empty", () => {
    expect(threadNameFromPrompt("   ")).toBe("Jazz");
  });
});

describe("spoilerBlock", () => {
  it("wraps text so Discord hides it until clicked", () => {
    expect(spoilerBlock("thinking out loud")).toBe("||thinking out loud||");
  });

  it("keeps a literal pipe pair from closing the spoiler early", () => {
    const wrapped = spoilerBlock("a || b");
    expect(wrapped.startsWith("||")).toBe(true);
    expect(wrapped.endsWith("||")).toBe(true);
    expect(wrapped.slice(2, -2)).not.toContain("||");
  });
});
