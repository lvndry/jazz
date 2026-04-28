import { describe, expect, it } from "bun:test";
import { getGlyphs, GLYPHS, resolveGlyphMode } from "./glyphs";

describe("glyphs", () => {
  describe("resolveGlyphMode", () => {
    it("defaults to ascii when env is unset", () => {
      const original = process.env["JAZZ_UI_GLYPHS"];
      delete process.env["JAZZ_UI_GLYPHS"];
      try {
        expect(resolveGlyphMode()).toBe("ascii");
      } finally {
        if (original !== undefined) process.env["JAZZ_UI_GLYPHS"] = original;
      }
    });

    it("returns unicode when JAZZ_UI_GLYPHS=unicode (any case)", () => {
      const original = process.env["JAZZ_UI_GLYPHS"];
      try {
        process.env["JAZZ_UI_GLYPHS"] = "unicode";
        expect(resolveGlyphMode()).toBe("unicode");
        process.env["JAZZ_UI_GLYPHS"] = "UNICODE";
        expect(resolveGlyphMode()).toBe("unicode");
        process.env["JAZZ_UI_GLYPHS"] = "Unicode";
        expect(resolveGlyphMode()).toBe("unicode");
      } finally {
        if (original === undefined) delete process.env["JAZZ_UI_GLYPHS"];
        else process.env["JAZZ_UI_GLYPHS"] = original;
      }
    });

    it("falls back to ascii for any other value", () => {
      const original = process.env["JAZZ_UI_GLYPHS"];
      try {
        for (const v of ["fancy", "emoji", "minimal", "", "truecolor"]) {
          process.env["JAZZ_UI_GLYPHS"] = v;
          expect(resolveGlyphMode()).toBe("ascii");
        }
      } finally {
        if (original === undefined) delete process.env["JAZZ_UI_GLYPHS"];
        else process.env["JAZZ_UI_GLYPHS"] = original;
      }
    });
  });

  describe("ASCII set is fully ASCII (portable)", () => {
    it("every character has codepoint < 128", () => {
      const set = GLYPHS.ascii;
      const fields: ReadonlyArray<keyof typeof set> = [
        "boxTL",
        "boxTJ",
        "boxTR",
        "boxML",
        "boxMJ",
        "boxMR",
        "boxBL",
        "boxBJ",
        "boxBR",
        "boxV",
        "boxH",
        "divider",
        "success",
        "error",
        "warn",
        "info",
        "debug",
        "bullet",
        "question",
        "heading1",
        "heading2",
        "heading3",
        "heading4",
        "blockquote",
        "promptCursor",
        "arrow",
        "pending",
        "proposed",
      ];
      for (const k of fields) {
        const v = set[k] as string;
        for (const ch of v) {
          expect(ch.charCodeAt(0)).toBeLessThan(128);
        }
      }
      for (const frame of set.spinnerFrames) {
        for (const ch of frame) {
          expect(ch.charCodeAt(0)).toBeLessThan(128);
        }
      }
    });

    it("heading markers are 1/2/3/4 hashes (matches hybrid mode)", () => {
      expect(GLYPHS.ascii.heading1).toBe("#");
      expect(GLYPHS.ascii.heading2).toBe("##");
      expect(GLYPHS.ascii.heading3).toBe("###");
      expect(GLYPHS.ascii.heading4).toBe("####");
    });
  });

  describe("getGlyphs picks the active set", () => {
    it("returns ascii by default", () => {
      const original = process.env["JAZZ_UI_GLYPHS"];
      delete process.env["JAZZ_UI_GLYPHS"];
      try {
        expect(getGlyphs()).toBe(GLYPHS.ascii);
      } finally {
        if (original !== undefined) process.env["JAZZ_UI_GLYPHS"] = original;
      }
    });

    it("returns unicode when env opts in", () => {
      const original = process.env["JAZZ_UI_GLYPHS"];
      process.env["JAZZ_UI_GLYPHS"] = "unicode";
      try {
        expect(getGlyphs()).toBe(GLYPHS.unicode);
      } finally {
        if (original === undefined) delete process.env["JAZZ_UI_GLYPHS"];
        else process.env["JAZZ_UI_GLYPHS"] = original;
      }
    });
  });
});
