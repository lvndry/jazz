import { describe, expect, it } from "bun:test";
import { buildMediaPrompt, extractMedia } from "./media";

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

describe("extractMedia", () => {
  it("picks the largest photo, not a thumbnail", () => {
    const media = extractMedia({
      photo: [{ file_id: "thumb" }, { file_id: "medium" }, { file_id: "full" }],
    });
    expect(media?.file.file_id).toBe("full");
  });

  it("prefers the animation over the document copy Telegram sends with a GIF", () => {
    const media = extractMedia({
      animation: { file_id: "gif" },
      document: { file_id: "gif-as-document" },
    });
    expect(media?.file.file_id).toBe("gif");
  });

  it("takes a video", () => {
    const media = extractMedia({ video: { file_id: "clip" } });
    expect(media?.file.file_id).toBe("clip");
  });

  it("asks a round video message to be acted on, like a voice note", () => {
    const media = extractMedia({ video_note: { file_id: "round" } });
    expect(media?.file.file_id).toBe("round");
    expect(media?.fallbackInstruction).toContain("do what it asks");
  });

  it("takes a static sticker", () => {
    const media = extractMedia({ sticker: { file_id: "webp-sticker" } });
    expect(media?.file.file_id).toBe("webp-sticker");
  });

  it("takes a video sticker", () => {
    const media = extractMedia({ sticker: { file_id: "webm-sticker", is_video: true } });
    expect(media?.file.file_id).toBe("webm-sticker");
  });

  it("skips an animated sticker — .tgs is Lottie JSON, not something a model can look at", () => {
    const media = extractMedia({ sticker: { file_id: "tgs-sticker", is_animated: true } });
    expect(media).toBeUndefined();
  });

  it("returns nothing for a message with no media", () => {
    expect(extractMedia({})).toBeUndefined();
  });
});
