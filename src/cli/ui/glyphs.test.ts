import { describe, expect, it } from "bun:test";
import { getGlyphs, GLYPHS, resolveGlyphMode } from "./glyphs";

const ENV_KEYS = [
  "JAZZ_UI_GLYPHS",
  "TERM",
  "TERM_PROGRAM",
  "LC_ALL",
  "LC_CTYPE",
  "LANG",
  "WT_SESSION",
] as const;

function withEnv(overrides: Record<string, string | undefined>, run: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("glyphs", () => {
  describe("resolveGlyphMode", () => {
    it("returns unicode when JAZZ_UI_GLYPHS=unicode (any case)", () => {
      for (const value of ["unicode", "UNICODE", "Unicode"]) {
        withEnv({ JAZZ_UI_GLYPHS: value, TERM: "dumb" }, () => {
          expect(resolveGlyphMode()).toBe("unicode");
        });
      }
    });

    it("returns ascii when JAZZ_UI_GLYPHS=ascii even on a capable terminal", () => {
      withEnv({ JAZZ_UI_GLYPHS: "ascii", LANG: "en_US.UTF-8" }, () => {
        expect(resolveGlyphMode()).toBe("ascii");
      });
    });

    it("detects unicode from a UTF-8 locale", () => {
      withEnv({ LANG: "en_US.UTF-8" }, () => {
        expect(resolveGlyphMode()).toBe("unicode");
      });
      withEnv({ LC_ALL: "fr_FR.utf8" }, () => {
        expect(resolveGlyphMode()).toBe("unicode");
      });
    });

    it("detects unicode from a known-capable TERM_PROGRAM without a locale", () => {
      for (const program of ["iTerm.app", "WezTerm", "vscode", "ghostty", "Apple_Terminal"]) {
        withEnv({ TERM_PROGRAM: program }, () => {
          expect(resolveGlyphMode()).toBe("unicode");
        });
      }
    });

    it("detects unicode in Windows Terminal via WT_SESSION", () => {
      withEnv({ WT_SESSION: "some-guid" }, () => {
        expect(resolveGlyphMode()).toBe("unicode");
      });
    });

    it("falls back to ascii on dumb/linux terminals even with UTF-8 locale", () => {
      withEnv({ TERM: "dumb", LANG: "en_US.UTF-8" }, () => {
        expect(resolveGlyphMode()).toBe("ascii");
      });
      withEnv({ TERM: "linux", LANG: "en_US.UTF-8" }, () => {
        expect(resolveGlyphMode()).toBe("ascii");
      });
    });

    it("falls back to ascii when nothing signals unicode support", () => {
      withEnv({}, () => {
        expect(resolveGlyphMode()).toBe("ascii");
      });
    });

    it("treats unrecognized JAZZ_UI_GLYPHS values as unset (detection applies)", () => {
      for (const value of ["fancy", "emoji", "minimal", "", "truecolor"]) {
        withEnv({ JAZZ_UI_GLYPHS: value }, () => {
          expect(resolveGlyphMode()).toBe("ascii");
        });
        withEnv({ JAZZ_UI_GLYPHS: value, LANG: "en_US.UTF-8" }, () => {
          expect(resolveGlyphMode()).toBe("unicode");
        });
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
        "active",
        "diamond",
        "note",
        "rail",
        "gridFilled",
        "gridEmpty",
        "gridReserved",
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
      for (const frame of set.meterFrames) {
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
    it("returns ascii when nothing signals unicode support", () => {
      withEnv({}, () => {
        expect(getGlyphs()).toBe(GLYPHS.ascii);
      });
    });

    it("returns unicode when env opts in", () => {
      withEnv({ JAZZ_UI_GLYPHS: "unicode" }, () => {
        expect(getGlyphs()).toBe(GLYPHS.unicode);
      });
    });

    it("returns unicode on a detected UTF-8 terminal", () => {
      withEnv({ LANG: "en_US.UTF-8" }, () => {
        expect(getGlyphs()).toBe(GLYPHS.unicode);
      });
    });
  });
});
