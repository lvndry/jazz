import { describe, expect, it } from "bun:test";
import { getGlyphs, GLYPHS, laneFrame, resolveGlyphMode, type GlyphSet } from "./glyphs";

/**
 * Unicode ranges whose coverage was verified against the `cmap` tables of the
 * fonts people actually use — Menlo, SF Mono, Consolas, DejaVu Sans Mono and
 * JetBrains Mono. Box Drawing and Block Elements are the only two ranges with
 * full coverage in all of them; the rest of this list is ASCII and a handful of
 * punctuation ranges that predate Unicode.
 *
 * Anything outside these ranges risks being drawn by a fallback font at a
 * mismatched advance width, which mis-aligns every column that follows it.
 */
const SAFE_RANGES: readonly (readonly [number, number, string])[] = [
  [0x0020, 0x007e, "ASCII printable"],
  [0x00a0, 0x00ff, "Latin-1 Supplement"],
  [0x2000, 0x206f, "General Punctuation"],
  [0x2200, 0x22ff, "Mathematical Operators"],
  [0x2500, 0x257f, "Box Drawing"],
  [0x2580, 0x259f, "Block Elements"],
];

/** Ranges that have burned us, kept explicit so the failure message is useful. */
const KNOWN_UNSAFE: readonly (readonly [number, number, string])[] = [
  [0x2190, 0x21ff, "Arrows — 11/112 in SF Mono"],
  [0x2300, 0x23ff, "Miscellaneous Technical — 7/256 in SF Mono"],
  [0x25a0, 0x25ff, "Geometric Shapes — 14/96 in SF Mono (◆ ◐ ● ○ live here)"],
  [0x2600, 0x26ff, "Miscellaneous Symbols — 0/256 in SF Mono (♪ lives here)"],
  [0x2700, 0x27bf, "Dingbats — 15/192 in SF Mono (✓ ✗ ❯ live here)"],
  [0x2800, 0x28ff, "Braille — 0/256 in every target font"],
];

/** Every character the set can emit, including animation frames. */
function everyCharacter(set: GlyphSet): string[] {
  const out: string[] = [];
  for (const value of Object.values(set)) {
    if (typeof value === "string") out.push(...value);
    else if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string") out.push(...entry);
      }
    }
  }
  return out;
}

function describeRange(
  codePoint: number,
  ranges: readonly (readonly [number, number, string])[],
): string | undefined {
  for (const [start, end, name] of ranges) {
    if (codePoint >= start && codePoint <= end) return name;
  }
  return undefined;
}

const greatestCommonDivisor = (a: number, b: number): number =>
  b === 0 ? a : greatestCommonDivisor(b, a % b);

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
      for (const cell of [...set.laneBurst, set.laneRest]) {
        for (const ch of cell) {
          expect(ch.charCodeAt(0)).toBeLessThan(128);
        }
      }
    });

    it("lane burst and rest are single cells", () => {
      for (const cell of [...GLYPHS.ascii.laneBurst, GLYPHS.ascii.laneRest]) {
        expect([...cell]).toHaveLength(1);
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

describe("font safety", () => {
  it("every Unicode-set character comes from a verified-safe range", () => {
    const offenders: string[] = [];
    for (const character of everyCharacter(GLYPHS.unicode)) {
      const codePoint = character.codePointAt(0) as number;
      if (describeRange(codePoint, SAFE_RANGES) !== undefined) continue;
      const unsafe = describeRange(codePoint, KNOWN_UNSAFE);
      offenders.push(
        `${character} (U+${codePoint.toString(16).toUpperCase().padStart(4, "0")})` +
          (unsafe === undefined ? "" : ` — ${unsafe}`),
      );
    }
    expect(offenders).toEqual([]);
  });

  it("uses no braille — it has zero coverage in every target monospace font", () => {
    for (const character of everyCharacter(GLYPHS.unicode)) {
      const codePoint = character.codePointAt(0) as number;
      expect(codePoint < 0x2800 || codePoint > 0x28ff).toBe(true);
    }
  });

  it("does not reintroduce the glyphs that were missing from SF Mono", () => {
    const previouslyShipped = ["◆", "◇", "◐", "●", "○", "♪", "✓", "✗", "❯", "⚠", "ℹ", "✧"];
    const emitted = new Set(everyCharacter(GLYPHS.unicode));
    for (const character of previouslyShipped) {
      expect(emitted.has(character)).toBe(false);
    }
  });

  it("avoids box-drawing corners terminals do not draw procedurally", () => {
    // Rounded, double and dashed forms are excluded from the procedural sets
    // terminals ship, so they fall through to the font and are the most
    // fallback-prone glyphs in an otherwise safe range.
    const avoid = ["╭", "╮", "╰", "╯", "╔", "═", "╗", "║", "╚", "╝", "╌", "╍", "╎", "╏"];
    const emitted = new Set(everyCharacter(GLYPHS.unicode));
    for (const character of avoid) {
      expect(emitted.has(character)).toBe(false);
    }
  });
});

describe("activity indicator", () => {
  it("lane periods are pairwise coprime, so the pattern does not loop quickly", () => {
    // Non-coprime periods were the original bug: 4, 6, 3, 4, 6 shares factors,
    // so the composite looped every 12 frames — about two seconds — and the two
    // pairs of equal periods were phase-locked to each other permanently.
    const periods = GLYPHS.unicode.lanePeriods;
    for (let a = 0; a < periods.length; a++) {
      for (let b = a + 1; b < periods.length; b++) {
        const first = periods[a] as number;
        const second = periods[b] as number;
        expect(greatestCommonDivisor(first, second)).toBe(1);
      }
    }
  });

  it("every period is long enough to hold the burst", () => {
    for (const period of GLYPHS.unicode.lanePeriods) {
      expect(period).toBeGreaterThanOrEqual(GLYPHS.unicode.laneBurst.length);
    }
  });

  it("runs for many minutes before repeating", () => {
    const composite = GLYPHS.unicode.lanePeriods.reduce(
      (a, b) => (a * b) / greatestCommonDivisor(a, b),
      1,
    );
    // 4620 frames at 170ms is about thirteen minutes.
    expect(composite).toBeGreaterThan(2000);
  });

  for (const mode of ["ascii", "unicode"] as const) {
    describe(mode, () => {
      const set = GLYPHS[mode];
      const composite = set.lanePeriods.reduce((a, b) => (a * b) / greatestCommonDivisor(a, b), 1);

      it("holds a constant width across the whole cycle", () => {
        for (let tick = 0; tick < composite; tick++) {
          expect([...laneFrame(tick, set)]).toHaveLength(set.lanePeriods.length);
        }
      });

      it("is never entirely at rest — an indicator that looks frozen is broken", () => {
        for (let tick = 0; tick < composite; tick++) {
          const frame = laneFrame(tick, set);
          expect([...frame].every((cell) => cell === set.laneRest)).toBe(false);
        }
      });

      it("almost never shows every lane in the same state, so it reads as several voices", () => {
        // Coprime periods make a full alignment inevitable somewhere in the
        // cycle, but it is vanishingly rare: 3 frames out of 4620, each lasting
        // one 170ms tick, so roughly half a second per thirteen minutes. What
        // would actually be a bug is a design where lanes share a period and
        // are therefore locked together permanently — that is what the coprime
        // test above prevents.
        let aligned = 0;
        for (let tick = 0; tick < composite; tick++) {
          if (new Set([...laneFrame(tick, set)]).size === 1) aligned++;
        }
        expect(aligned / composite).toBeLessThan(0.005);
      });

      it("shows a healthy variety of frames", () => {
        const distinct = new Set<string>();
        for (let tick = 0; tick < composite; tick++) distinct.add(laneFrame(tick, set));
        expect(distinct.size).toBeGreaterThan(100);
      });
    });
  }
});
