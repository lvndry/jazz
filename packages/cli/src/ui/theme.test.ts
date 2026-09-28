import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import chalk from "chalk";
import {
  applyTerminalPalette,
  applyTheme,
  codeColor,
  getCanvasMode,
  getThemeName,
  getThemeRevision,
  getThemeVariant,
  groundPaint,
  initializeTheme,
  listThemes,
  neutralPalette,
  noColorRequested,
  onThemeChange,
  PALETTES,
  parseThemeSelection,
  previewTheme,
  revertPreview,
  setCanvasMode,
  setTerminalBackground,
  setThemeVariant,
  THEME,
  themeWarnings,
  variantFromColorFgBg,
  type ThemeColors,
} from "./theme";
import { contrastRatio, TRANSPARENT, type VariantColors } from "./themes/format";
import { builtinThemes, generateSystemTheme, setSystemTheme } from "./themes/registry";

/**
 * The rest of the suite runs with `chalk.level === 0`, which makes every
 * colour assertion vacuous — `chalk.hex("#ABCDEF")("x")` returns `"x"`. So
 * these tests assert the properties of the palettes themselves, and force
 * truecolor where output is compared.
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

/** Below this distance two roles read as one colour. */
const CONFUSABLE_DISTANCE = 120;

function restoreDefaults(): void {
  delete process.env["JAZZ_THEME"];
  setSystemTheme(null);
  setTerminalBackground(null);
  initializeTheme({});
}

afterAll(restoreDefaults);

describe("built-in theme laws", () => {
  for (const definition of builtinThemes()) {
    for (const variant of ["dark", "light"] as const) {
      const colors = definition.variants[variant] as VariantColors;
      describe(`${definition.name} ${variant}`, () => {
        it("ships both variants", () => {
          expect(colors).toBeDefined();
        });

        it("paints an opaque ground", () => {
          expect(() => parseHex(colors.background)).not.toThrow();
        });

        it("defines every role as a 6-digit hex colour", () => {
          for (const [role, value] of Object.entries(colors)) {
            expect(() => parseHex(value), role).not.toThrow();
          }
        });

        it("keeps text legible against the ground", () => {
          // WCAG AAA for primary text, AA for secondary and for every hue a
          // person has to read; dim text is deliberately quiet but clears the
          // AA floor for large text, because it carries timestamps and receipts.
          expect(contrastRatio(colors.selected, colors.background)).toBeGreaterThan(7);
          expect(contrastRatio(colors.secondary, colors.background)).toBeGreaterThan(4.5);
          expect(contrastRatio(colors.muted, colors.background)).toBeGreaterThan(3);
          for (const role of ["primary", "success", "warning", "error"] as const) {
            expect(contrastRatio(colors[role], colors.background), role).toBeGreaterThan(4.5);
          }
        });

        it("steps the tiers away from the ground in order", () => {
          const fromGround = (color: string): number => contrastRatio(color, colors.background);
          expect(fromGround(colors.backgroundPanel)).toBeLessThan(
            fromGround(colors.backgroundElement),
          );
          expect(fromGround(colors.borderSubtle)).toBeLessThanOrEqual(fromGround(colors.border));
          expect(fromGround(colors.border)).toBeLessThanOrEqual(fromGround(colors.borderActive));
        });

        it("does not repeat one hue across accent, warning and inline code", () => {
          // The bug this guards: brand, warning and code were all the same amber,
          // so a bulleted list with bold text and a code span rendered as a wall
          // of orange with no distinctions left to read.
          const roles = ["primary", "warning", "syntaxValue"] as const;
          for (let first = 0; first < roles.length; first++) {
            for (let second = first + 1; second < roles.length; second++) {
              const one = colors[roles[first] as (typeof roles)[number]];
              const other = colors[roles[second] as (typeof roles)[number]];
              expect(perceptualDistance(one, other)).toBeGreaterThan(CONFUSABLE_DISTANCE);
            }
          }
        });

        it("keeps success distinct from every syntax tint", () => {
          // Success green means exactly one thing, which is why no syntax colour
          // is allowed to be green.
          for (const role of ["syntaxStructure", "syntaxValue", "syntaxType"] as const) {
            expect(perceptualDistance(colors.success, colors[role]), role).toBeGreaterThan(
              CONFUSABLE_DISTANCE,
            );
          }
        });

        it("keeps error and warning far enough apart to never be confused", () => {
          expect(perceptualDistance(colors.error, colors.warning)).toBeGreaterThan(
            CONFUSABLE_DISTANCE,
          );
        });

        it("uses one accent, so the marker glyph carries who is speaking", () => {
          expect(colors.agent).toBe(colors.primary);
          expect(colors.prompt).toBe(colors.primary);
        });
      });
    }
  }
});

describe("house theme fidelity", () => {
  const dark = PALETTES.dark;
  const light = PALETTES.light;

  it("holds house text above the stricter house contrast floors", () => {
    for (const palette of [dark, light]) {
      expect(contrastRatio(palette.selected, palette.canvas)).toBeGreaterThan(10);
      expect(contrastRatio(palette.secondary, palette.canvas)).toBeGreaterThan(6);
    }
  });

  it("paints the neutral ramp the house model specifies", () => {
    expect([dark.background, dark.backgroundPanel, dark.backgroundElement]).toEqual([
      "#0A0A0A",
      "#141414",
      "#1E1E1E",
    ]);
    expect([dark.borderSubtle, dark.border, dark.selected, dark.muted]).toEqual([
      "#282828",
      "#3C3C3C",
      "#EEEEEE",
      "#808080",
    ]);
    expect([light.background, light.backgroundPanel, light.backgroundElement]).toEqual([
      "#FFFFFF",
      "#FAFAFA",
      "#F3F3F3",
    ]);
    expect([light.border, light.selected, light.muted]).toEqual(["#E4E4E4", "#1A1A1A", "#8A8A8A"]);
  });

  it("puts the dark accent, its dim, success and warning on exact xterm cube vertices", () => {
    // This is what makes them byte-identical over SSH rather than approximated
    // by a downgrade to 256 colours.
    for (const role of ["primary", "accentDim", "success", "warning"] as const) {
      for (const channel of parseHex(dark[role])) {
        expect(CUBE_LEVELS, role).toContain(channel);
      }
    }
  });
});

describe("selection", () => {
  afterEach(restoreDefaults);

  it("reads a name, a variant, or both", () => {
    expect(parseThemeSelection("catppuccin")).toEqual({ name: "catppuccin" });
    expect(parseThemeSelection("light")).toEqual({ variant: "light" });
    expect(parseThemeSelection("catppuccin:light")).toEqual({
      name: "catppuccin",
      variant: "light",
    });
    expect(parseThemeSelection("Catppuccin Light")).toEqual({
      name: "catppuccin",
      variant: "light",
    });
    expect(parseThemeSelection("")).toBeNull();
    expect(parseThemeSelection("a b c")).toBeNull();
  });

  it("reads COLORFGBG's background index", () => {
    expect(variantFromColorFgBg("0;15")).toBe("light");
    expect(variantFromColorFgBg("15;0")).toBe("dark");
    expect(variantFromColorFgBg(undefined)).toBeUndefined();
  });

  it("applies a theme and reports the setting that reproduces it", () => {
    const result = applyTheme("catppuccin light");
    expect(result).toMatchObject({ ok: true, name: "catppuccin", setting: "catppuccin:light" });
    expect(getThemeName()).toBe("catppuccin");
    expect(getThemeVariant()).toBe("light");
  });

  it("keeps the family when only a variant is asked for", () => {
    applyTheme("catppuccin");
    const result = applyTheme("dark");
    expect(result).toMatchObject({ ok: true, name: "catppuccin", setting: "catppuccin:dark" });
  });

  it("rejects an unknown theme without changing anything", () => {
    applyTheme("catppuccin");
    const revision = getThemeRevision();
    expect(applyTheme("no-such-theme")).toEqual({
      ok: false,
      error: 'no theme named "no-such-theme"',
    });
    expect(getThemeName()).toBe("catppuccin");
    expect(getThemeRevision()).toBe(revision);
  });

  it("previews without committing, and reverts to the committed theme", () => {
    applyTheme("jazz dark");
    previewTheme("catppuccin light");
    expect(getThemeName()).toBe("catppuccin");
    expect(listThemes().find((listing) => listing.current)?.id).toBe("jazz:dark");
    revertPreview();
    expect(getThemeName()).toBe("jazz");
    expect(getThemeVariant()).toBe("dark");
  });

  it("marks exactly one listing as current", () => {
    applyTheme("catppuccin:dark");
    const current = listThemes().filter((listing) => listing.current);
    expect(current.map((listing) => listing.id)).toEqual(["catppuccin:dark"]);
  });

  it("lets JAZZ_THEME win over ui.theme", () => {
    process.env["JAZZ_THEME"] = "catppuccin:light";
    expect(initializeTheme({ configured: "jazz:dark" })).toEqual([]);
    expect(getThemeName()).toBe("catppuccin");
    expect(getThemeVariant()).toBe("light");
  });

  it("falls back and warns for an unknown configured theme", () => {
    const warnings = initializeTheme({ configured: "nope:light", canvas: "painted" });
    expect(warnings).toEqual(['ui.theme names an unknown theme "nope"; using the default']);
    expect(getThemeName()).toBe("jazz");
    expect(getThemeVariant()).toBe("light");
  });

  it("switches variant in place so render-time readers see it", () => {
    initializeTheme({ canvas: "painted" });
    setThemeVariant("dark");
    const darkAccent = THEME.primary;
    setThemeVariant("light");
    expect(THEME.primary).not.toBe(darkAccent);
    expect(getThemeVariant()).toBe("light");
  });

  it("switches inline-code colour too, rather than baking it at import", () => {
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
    } finally {
      chalk.level = previousLevel;
    }
  });
});

describe("repaint signal", () => {
  afterEach(restoreDefaults);

  it("tells subscribers about every change and bumps the revision", () => {
    let calls = 0;
    const stop = onThemeChange(() => {
      calls++;
    });
    const before = getThemeRevision();
    applyTheme("catppuccin");
    previewTheme("jazz");
    revertPreview();
    stop();
    applyTheme("jazz");
    expect(calls).toBe(3);
    expect(getThemeRevision()).toBe(before + 4);
  });
});

describe("canvas modes", () => {
  afterEach(restoreDefaults);

  it("inherits the terminal's ground by default, on the system theme", () => {
    initializeTheme({});
    expect(getCanvasMode()).toBe("inherit");
    expect(getThemeName()).toBe("system");
    expect(groundPaint()).toBe(TRANSPARENT);
    expect(() => parseHex(THEME.canvas)).not.toThrow();
  });

  it("paints the theme's ground in painted mode, on the house theme", () => {
    initializeTheme({ canvas: "painted" });
    expect(getThemeName()).toBe("jazz");
    setThemeVariant("dark");
    expect(groundPaint()).toBe("#0A0A0A");
    expect(THEME.canvas).toBe("#0A0A0A");
  });

  it("derives the tiers from the terminal's real background when inheriting", () => {
    initializeTheme({ configured: "jazz:dark" });
    setTerminalBackground("#202020");
    expect(THEME.canvas).toBe("#202020");
    expect(groundPaint()).toBe(TRANSPARENT);
    const fromGround = (color: string): number => contrastRatio(color, "#202020");
    expect(fromGround(THEME.backgroundPanel)).toBeGreaterThan(1);
    expect(fromGround(THEME.backgroundPanel)).toBeLessThan(fromGround(THEME.backgroundElement));
    expect(THEME.surface).toBe(THEME.backgroundPanel);
  });

  it("leaves a theme's own tiers alone in painted mode", () => {
    initializeTheme({ configured: "jazz:dark", canvas: "painted" });
    setTerminalBackground("#202020");
    expect(THEME.backgroundPanel).toBe("#141414");
  });

  it("picks the variant from the terminal's background when nothing pins one", () => {
    initializeTheme({ configured: "catppuccin" });
    setTerminalBackground("#F5F5F5");
    expect(getThemeVariant()).toBe("light");
    setTerminalBackground("#101010");
    expect(getThemeVariant()).toBe("dark");
  });

  it("switches between modes live", () => {
    initializeTheme({ configured: "jazz:dark" });
    setCanvasMode("painted");
    expect(groundPaint()).toBe("#0A0A0A");
    setCanvasMode("inherit");
    expect(groundPaint()).toBe(TRANSPARENT);
  });
});

describe("system theme", () => {
  afterEach(restoreDefaults);

  const report = {
    palette: [
      "#1d1f21",
      "#cc6666",
      "#b5bd68",
      "#f0c674",
      "#81a2be",
      "#b294bb",
      "#8abeb7",
      "#c5c8c6",
      null,
      null,
      null,
      null,
      null,
      null,
      "#a3e0d8",
    ],
    defaultForeground: "#c5c8c6",
    defaultBackground: "#1d1f21",
  };

  it("uses the terminal's ANSI colours and a transparent ground", () => {
    const colors = generateSystemTheme(report, "dark").variants.dark as VariantColors;
    expect(colors.background).toBe(TRANSPARENT);
    expect(colors.primary).toBe("#8ABEB7");
    expect(colors.error).toBe("#CC6666");
    expect(colors.success).toBe("#B5BD68");
    expect(colors.selected).toBe("#C5C8C6");
    expect(colors.syntaxType).toBe("#A3E0D8");
  });

  it("derives quiet tiers and a dim text from the real ground", () => {
    const colors = generateSystemTheme(report, "dark").variants.dark as VariantColors;
    const fromGround = (color: string): number => contrastRatio(color, "#1d1f21");
    expect(fromGround(colors.backgroundPanel)).toBeLessThan(fromGround(colors.backgroundElement));
    expect(fromGround(colors.backgroundElement)).toBeLessThan(fromGround(colors.border));
    expect(fromGround(colors.muted)).toBeGreaterThan(3);
  });

  it("becomes the default once the terminal answers", () => {
    initializeTheme({});
    applyTerminalPalette(report);
    expect(getThemeName()).toBe("system");
    expect(THEME.primary).toBe("#8ABEB7");
    expect(THEME.canvas).toBe("#1D1F21");
  });

  it("falls back to xterm's colours for anything the terminal did not report", () => {
    const colors = generateSystemTheme(
      { palette: [], defaultForeground: null, defaultBackground: null },
      "dark",
    ).variants.dark as VariantColors;
    expect(colors.error).toBe("#800000");
    expect(colors.selected).toBe(PALETTES.dark.selected);
  });
});

describe("user themes", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "jazz-themes-"));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
    restoreDefaults();
  });

  const minimalTheme = {
    name: "paper-ink",
    defs: { paper: "#ffffff", ink: "#111111", blue: "#0645ad" },
    theme: {
      background: "paper",
      backgroundPanel: "#f6f6f6",
      backgroundElement: "#eeeeee",
      borderSubtle: "#e8e8e8",
      border: "#dddddd",
      selected: "ink",
      secondary: "#444444",
      muted: "#6f6f6f",
      primary: "blue",
      accentDim: "blue",
      success: "#0a6b2b",
      warning: "#8a5200",
      error: "#b00020",
      syntaxStructure: "#5b3fbf",
      syntaxValue: "#9b2c6f",
      syntaxType: "#2f6690",
    },
  };

  it("loads a theme file from the themes directory", () => {
    writeFileSync(path.join(directory, "paper-ink.json"), JSON.stringify(minimalTheme));
    initializeTheme({ themesDirectory: directory, configured: "paper-ink", canvas: "painted" });
    expect(getThemeName()).toBe("paper-ink");
    expect(getThemeVariant()).toBe("light");
    expect(THEME.primary).toBe("#0645AD");
    expect(themeWarnings()).toEqual([]);
  });

  it("skips a broken file with a warning naming the file and the bad key", () => {
    const broken = { ...minimalTheme, theme: { ...minimalTheme.theme, primary: "nope" } };
    writeFileSync(path.join(directory, "broken.json"), JSON.stringify(broken));
    writeFileSync(path.join(directory, "garbage.json"), "{ not json");
    initializeTheme({ themesDirectory: directory, configured: "paper-ink" });
    expect(listThemes().some((listing) => listing.name === "paper-ink")).toBe(false);
    const warnings = themeWarnings();
    expect(warnings.some((warning) => warning.startsWith("broken.json: theme.primary:"))).toBe(
      true,
    );
    expect(warnings.some((warning) => warning.startsWith("garbage.json: not valid JSON"))).toBe(
      true,
    );
  });

  it("refuses to shadow a built-in", () => {
    writeFileSync(
      path.join(directory, "jazz.json"),
      JSON.stringify({ ...minimalTheme, name: "jazz" }),
    );
    initializeTheme({ themesDirectory: directory });
    expect(themeWarnings()).toEqual([
      'jazz.json: "jazz" is a built-in theme; rename it to use your version',
    ]);
  });

  it("warns about, but still loads, a theme that is hard to read", () => {
    const faint = { ...minimalTheme, theme: { ...minimalTheme.theme, muted: "#eeeeee" } };
    writeFileSync(path.join(directory, "faint.json"), JSON.stringify(faint));
    initializeTheme({ themesDirectory: directory });
    expect(listThemes().some((listing) => listing.name === "paper-ink")).toBe(true);
    expect(themeWarnings()[0]).toContain("light muted is 1.2:1 against the background");
  });
});

describe("NO_COLOR", () => {
  it("counts only a non-empty value as a request", () => {
    expect(noColorRequested({ NO_COLOR: "1" })).toBe(true);
    expect(noColorRequested({ NO_COLOR: "" })).toBe(false);
    expect(noColorRequested({})).toBe(false);
  });

  it("paints every role with the neutral ramp and keeps the grounds", () => {
    for (const variant of ["dark", "light"] as const) {
      const palette = PALETTES[variant];
      const neutral = neutralPalette(palette);
      const ramp = new Set([palette.selected, palette.secondary, palette.muted]);
      const grounds: readonly (keyof ThemeColors)[] = [
        "background",
        "backgroundPanel",
        "backgroundElement",
        "borderSubtle",
        "border",
        "borderActive",
        "canvas",
        "toolBorder",
        "surface",
        "surfaceSoft",
        "surfaceStrong",
        "borderSoft",
      ];
      for (const key of Object.keys(neutral) as (keyof ThemeColors)[]) {
        if (grounds.includes(key)) {
          expect(neutral[key]).toBe(palette[key]);
        } else {
          expect(ramp.has(neutral[key]), `${variant}.${key}`).toBe(true);
        }
      }
    }
  });
});
