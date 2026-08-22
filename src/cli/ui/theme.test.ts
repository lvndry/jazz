import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import chalk from "chalk";
import {
  codeColor,
  getThemeVariant,
  setThemeVariant,
  THEME,
  type ThemeColors,
  type ThemeVariant,
} from "./theme";

/**
 * The rest of the suite runs with `chalk.level === 0`, which makes every
 * colour assertion vacuous — `chalk.hex("#ABCDEF")("x")` returns `"x"`. So
 * the palette itself was previously untested, and a colour could change to
 * anything without a single failure. These tests assert the properties that
 * actually matter, and force truecolor where output is compared.
 */

function parseHex(hex: string): [number, number, number] {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (match === null) throw new Error(`not a 6-digit hex colour: ${hex}`);
  return [
    Number.parseInt(match[1] as string, 16),
    Number.parseInt(match[2] as string, 16),
    Number.parseInt(match[3] as string, 16),
  ];
}

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const channels = parseHex(hex).map((value) => {
    const fraction = value / 255;
    return fraction <= 0.03928 ? fraction / 12.92 : ((fraction + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground: string, background: string): number {
  const first = luminance(foreground);
  const second = luminance(background);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * A cheap perceptual distance ("redmean"), good enough to answer the only
 * question asked of it: would a person read these two as the same colour?
 */
function perceptualDistance(first: string, second: string): number {
  const [r1, g1, b1] = parseHex(first);
  const [r2, g2, b2] = parseHex(second);
  const meanRed = (r1 + r2) / 2;
  const deltaR = r1 - r2;
  const deltaG = g1 - g2;
  const deltaB = b1 - b2;
  return Math.sqrt(
    (2 + meanRed / 256) * deltaR * deltaR +
      4 * deltaG * deltaG +
      (2 + (255 - meanRed) / 256) * deltaB * deltaB,
  );
}

/** The 6×6×6 colour cube that xterm indices 16–231 are built from. */
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

const TOKEN_KEYS: readonly (keyof ThemeColors)[] = [
  "canvas",
  "primary",
  "agent",
  "accentDim",
  "link",
  "success",
  "error",
  "warning",
  "info",
  "selected",
  "prompt",
  "secondary",
  "muted",
  "reasoning",
  "toolBorder",
  "surface",
  "surfaceSoft",
  "surfaceStrong",
  "border",
  "borderSoft",
  "syntaxStructure",
  "syntaxValue",
  "syntaxType",
];

describe("theme", () => {
  const originalVariant = getThemeVariant();
  const originalLevel = chalk.level;

  afterAll(() => {
    setThemeVariant(originalVariant);
    chalk.level = originalLevel;
  });

  for (const variant of ["dark", "light"] as const satisfies readonly ThemeVariant[]) {
    describe(variant, () => {
      beforeAll(() => {
        setThemeVariant(variant);
      });

      it("defines every token as a 6-digit hex colour", () => {
        for (const key of TOKEN_KEYS) {
          expect(() => parseHex(THEME[key])).not.toThrow();
        }
      });

      it("keeps body text comfortably legible against the canvas", () => {
        // Roughly WCAG AAA for primary text, AA for secondary. Dim text is
        // deliberately quiet but must still clear the AA floor for large text,
        // because it carries timestamps and settled receipts.
        expect(contrastRatio(THEME.selected, THEME.canvas)).toBeGreaterThan(10);
        expect(contrastRatio(THEME.secondary, THEME.canvas)).toBeGreaterThan(6);
        expect(contrastRatio(THEME.muted, THEME.canvas)).toBeGreaterThan(3);
      });

      it("keeps the accent and every status hue legible against the canvas", () => {
        for (const key of ["primary", "success", "warning", "error"] as const) {
          expect(contrastRatio(THEME[key], THEME.canvas)).toBeGreaterThan(4.5);
        }
      });

      it("does not repeat one hue across brand, warning and inline code", () => {
        // The bug this guards: brand, warning and code were all the same amber,
        // so a bulleted list with bold text and a code span rendered as a wall
        // of orange with no distinctions left to read.
        const roles = ["primary", "warning", "syntaxValue"] as const;
        for (let a = 0; a < roles.length; a++) {
          for (let b = a + 1; b < roles.length; b++) {
            const first = THEME[roles[a] as (typeof roles)[number]];
            const second = THEME[roles[b] as (typeof roles)[number]];
            expect(perceptualDistance(first, second)).toBeGreaterThan(120);
          }
        }
      });

      it("keeps success distinct from every syntax tint", () => {
        // Success green means exactly one thing, which is why no syntax colour
        // is allowed to be green.
        for (const key of ["syntaxStructure", "syntaxValue", "syntaxType"] as const) {
          expect(perceptualDistance(THEME.success, THEME[key])).toBeGreaterThan(120);
        }
      });

      it("keeps error and warning far enough apart to never be confused", () => {
        expect(perceptualDistance(THEME.error, THEME.warning)).toBeGreaterThan(120);
      });

      it("uses one accent, so the marker glyph carries who is speaking", () => {
        expect(THEME.agent).toBe(THEME.primary);
        expect(THEME.prompt).toBe(THEME.primary);
      });
    });
  }

  describe("dark palette fidelity", () => {
    beforeAll(() => {
      setThemeVariant("dark");
    });

    it("puts the accent on an exact xterm-256 cube vertex", () => {
      // This is what makes the accent byte-identical over SSH rather than
      // approximated by chalk's downgrade to 256 colours.
      for (const channel of parseHex(THEME.primary)) {
        expect(CUBE_LEVELS).toContain(channel);
      }
    });

    it("puts accentDim, success and warning on exact cube vertices too", () => {
      for (const key of ["accentDim", "success", "warning"] as const) {
        for (const channel of parseHex(THEME[key])) {
          expect(CUBE_LEVELS).toContain(channel);
        }
      }
    });
  });

  describe("runtime variant switching", () => {
    it("changes the palette in place so render-time readers see it", () => {
      setThemeVariant("dark");
      const darkAccent = THEME.primary;
      setThemeVariant("light");
      expect(THEME.primary).not.toBe(darkAccent);
      expect(getThemeVariant()).toBe("light");
    });

    it("switches inline-code colour too, rather than baking it at import", () => {
      // codeColor used to be resolved once at module load, so `/theme` left it
      // on the previous palette until the next process.
      //
      // chalk.level is process-global and the rest of the suite runs at 0.
      // Restore it in a finally rather than in afterAll: other files' tests can
      // interleave with this one, and leaving truecolor on turns their colour
      // assertions from vacuous into real, which fails them for the wrong
      // reason.
      const previousLevel = chalk.level;
      chalk.level = 3;
      try {
        setThemeVariant("dark");
        const dark = codeColor("x");
        setThemeVariant("light");
        const light = codeColor("x");
        expect(dark).not.toBe(light);
        expect(dark).toContain("x");
        expect(light).toContain("x");
      } finally {
        chalk.level = previousLevel;
      }
    });
  });
});
