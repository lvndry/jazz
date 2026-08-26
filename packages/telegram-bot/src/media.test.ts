import { describe, expect, it } from "bun:test";
import { buildMediaPrompt } from "./media";

describe("buildMediaPrompt", () => {
  it("puts the path on its own line — mentioning it is what attaches the file", () => {
    const prompt = buildMediaPrompt("/data/tg-media/1-2.ogg", undefined, "Listen to this.");
    expect(prompt).toContain("/data/tg-media/1-2.ogg");
    expect(prompt.split("\n").at(-1)).toBe("/data/tg-media/1-2.ogg");
  });

  it("uses the caption as the request when the user wrote one", () => {
    const prompt = buildMediaPrompt("/tmp/a.png", "what font is this?", "Look at this image.");
    expect(prompt).toContain("what font is this?");
    expect(prompt).not.toContain("Look at this image.");
  });

  it("falls back to an instruction when there is no caption", () => {
    // A bare path with no request tends to produce a shrug from the model.
    const prompt = buildMediaPrompt("/tmp/a.ogg", undefined, "Listen and act on it.");
    expect(prompt).toContain("Listen and act on it.");
  });

  it("treats a whitespace-only caption as absent", () => {
    const prompt = buildMediaPrompt("/tmp/a.ogg", "   ", "Listen and act on it.");
    expect(prompt).toContain("Listen and act on it.");
  });

  it("trims the caption", () => {
    const prompt = buildMediaPrompt("/tmp/a.png", "  what is this?  ", "fallback");
    expect(prompt.startsWith("what is this?")).toBe(true);
  });
});
