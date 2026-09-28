import { describe, expect, it } from "bun:test";
import { DERIVED_ROLES, FILE_ROLES, parseThemeFile, TRANSPARENT, xtermIndexToHex } from "./format";
import schema from "./theme.schema.json";

const roles = {
  background: "ground",
  backgroundPanel: "#141414",
  backgroundElement: "#1e1e1e",
  borderSubtle: "#282828",
  border: "#3c3c3c",
  selected: "#eeeeee",
  secondary: "#a8a8a8",
  muted: "#808080",
  primary: "accent",
  accentDim: "#00afd7",
  success: "#5fd787",
  warning: "#d7af5f",
  error: "#ff6b6b",
  syntaxStructure: "#9b8cff",
  syntaxValue: "#d787af",
  syntaxType: "#92b4c8",
};

function file(overrides: Record<string, unknown> = {}, defs: Record<string, unknown> = {}) {
  return {
    name: "sample",
    defs: { ground: "#0a0a0a", accent: 45, ...defs },
    theme: { ...roles, ...overrides },
  };
}

function errorsOf(input: unknown): readonly string[] {
  const result = parseThemeFile(input, "test");
  return result.ok ? [] : result.errors;
}

describe("parseThemeFile", () => {
  it("resolves defs, xterm indices, and derived roles", () => {
    const result = parseThemeFile(file(), "test");
    if (!result.ok) throw new Error(result.errors.join("; "));
    const dark = result.theme.variants.dark;
    expect(result.theme.variants.light).toBeUndefined();
    expect(dark?.background).toBe("#0A0A0A");
    expect(dark?.primary).toBe("#00D7FF");
    expect(dark?.agent).toBe("#00D7FF");
    expect(dark?.link).toBe("#00AFD7");
    expect(dark?.borderActive).toBe("#3C3C3C");
  });

  it("serves both variants from one file when a role splits", () => {
    const result = parseThemeFile(
      file({
        background: { dark: "ground", light: "#ffffff" },
        selected: { dark: "#eeeeee", light: "#1a1a1a" },
      }),
      "test",
    );
    if (!result.ok) throw new Error(result.errors.join("; "));
    expect(result.theme.variants.dark?.background).toBe("#0A0A0A");
    expect(result.theme.variants.light?.background).toBe("#FFFFFF");
    expect(result.theme.variants.light?.selected).toBe("#1A1A1A");
    expect(result.theme.variants.light?.primary).toBe("#00D7FF");
  });

  it("lets a role reference another role", () => {
    const result = parseThemeFile(file({ accentDim: "primary" }), "test");
    if (!result.ok) throw new Error(result.errors.join("; "));
    expect(result.theme.variants.dark?.accentDim).toBe("#00D7FF");
  });

  it("accepts transparent and none for the ground", () => {
    for (const value of ["transparent", "none"]) {
      const result = parseThemeFile(file({ background: value }), "test");
      if (!result.ok) throw new Error(result.errors.join("; "));
      expect(result.theme.variants.dark?.background).toBe(TRANSPARENT);
    }
  });

  it("refuses a transparent text colour", () => {
    expect(errorsOf(file({ selected: "transparent" }))).toEqual([
      "theme.selected: only background, backgroundPanel, backgroundElement may be transparent; text needs a colour",
    ]);
  });

  it("names a reference cycle", () => {
    expect(errorsOf(file({ primary: "loopA" }, { loopA: "loopB", loopB: "loopA" }))).toEqual([
      "defs.loopB: reference cycle primary → loopA → loopB → loopA",
    ]);
  });

  it("names the missing role, the unknown role and the unknown key", () => {
    const { primary: _removed, ...withoutPrimary } = roles;
    const errors = errorsOf({
      name: "sample",
      extra: true,
      defs: { ground: "#0a0a0a" },
      theme: { ...withoutPrimary, sparkle: "#ffffff" },
    });
    expect(errors).toContain('unknown key "extra"');
    expect(errors.some((error) => error.startsWith("theme.sparkle: unknown role"))).toBe(true);
    expect(errors).toContain("theme.primary: missing");
  });

  it("names a bad hex, a bad index and a half variant split", () => {
    expect(errorsOf(file({ muted: "#12345" }))).toEqual([
      'theme.muted: "#12345" is not a 6-digit "#RRGGBB" colour',
    ]);
    expect(errorsOf(file({ muted: 256 }))).toEqual([
      "theme.muted: 256 is not an xterm-256 index (a whole number 0–255)",
    ]);
    expect(errorsOf(file({ muted: { dark: "#808080" } }))).toEqual([
      'theme.muted: a variant split needs both "dark" and "light"',
    ]);
  });

  it("rejects a name that could not be typed after /theme", () => {
    expect(errorsOf({ ...file(), name: "My Theme" })).toEqual([
      'name: expected lowercase letters, digits and dashes, got "My Theme"',
    ]);
  });

  it("paints a def's xterm index exactly in a 256-colour terminal", () => {
    const input = file({}, { ground: { color: "#0a0a0a", xterm: 232 } });
    const truecolor = parseThemeFile(input, "test");
    const limited = parseThemeFile(input, "test", { xterm256: true });
    if (!truecolor.ok || !limited.ok) throw new Error("expected both to parse");
    expect(truecolor.theme.variants.dark?.background).toBe("#0A0A0A");
    expect(limited.theme.variants.dark?.background).toBe(xtermIndexToHex(232));
  });

  it("works out the variant of a single-variant file from its ground", () => {
    const result = parseThemeFile(file({}, { ground: "#fbfbfb" }), "test");
    if (!result.ok) throw new Error(result.errors.join("; "));
    expect(Object.keys(result.theme.variants)).toEqual(["light"]);
  });
});

describe("theme.schema.json", () => {
  it("lists exactly the roles the parser reads, requiring the ones without a default", () => {
    const themeSchema = schema.properties.theme;
    expect(Object.keys(themeSchema.properties).sort()).toEqual([...FILE_ROLES].sort());
    const required = FILE_ROLES.filter((role) => DERIVED_ROLES[role] === undefined);
    expect([...themeSchema.required].sort()).toEqual([...required].sort());
  });
});

describe("xtermIndexToHex", () => {
  it("covers the base colours, the cube and the grey ramp", () => {
    expect(xtermIndexToHex(1)).toBe("#800000");
    expect(xtermIndexToHex(45)).toBe("#00D7FF");
    expect(xtermIndexToHex(232)).toBe("#080808");
    expect(xtermIndexToHex(255)).toBe("#EEEEEE");
  });
});
