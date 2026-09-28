/**
 * Every theme jazz can paint with: the built-ins embedded in the binary, the generated `system`
 * theme, and the user's own files in `$JAZZ_HOME/themes/*.json` (see `setUserThemesDirectory`).
 *
 * User files are read synchronously because the first frame needs a palette before anything
 * asynchronous has run. A file that fails to parse or validate is skipped with a warning naming
 * the file and the bad key, and never stops jazz from starting. A user file that reuses a
 * built-in's name is skipped too: the built-ins are the ones held to the legibility laws in
 * `theme.test.ts`, so a name like `jazz` always means the tested palette.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import chalk from "chalk";
import type { ThemeVariant } from "../theme";
import catppuccin from "./builtin/catppuccin.json";
import jazz from "./builtin/jazz.json";
import {
  legibilityWarnings,
  parseThemeFile,
  TRANSPARENT,
  xtermIndexToHex,
  type ThemeDefinition,
  type VariantColors,
} from "./format";

/** The theme `painted` mode starts on, and the fallback for anything unusable. */
export const HOUSE_THEME = "jazz";

/** The theme generated from the terminal's own palette, and `inherit` mode's default. */
export const SYSTEM_THEME = "system";

const CHALK_LEVEL_256 = 2;

/** 256-colour terminals paint each def's `xterm` index exactly rather than a rounded hex. */
const PARSE_OPTIONS = { xterm256: chalk.level === CHALK_LEVEL_256 };

const BUILTIN_FILES: readonly (readonly [string, unknown])[] = [
  ["jazz.json", jazz],
  ["catppuccin.json", catppuccin],
];

function loadBuiltins(): ReadonlyMap<string, ThemeDefinition> {
  const themes = new Map<string, ThemeDefinition>();
  for (const [file, json] of BUILTIN_FILES) {
    const result = parseThemeFile(json, "builtin", PARSE_OPTIONS);
    if (!result.ok) {
      throw new Error(`built-in theme ${file} is invalid: ${result.errors.join("; ")}`);
    }
    themes.set(result.theme.name, result.theme);
  }
  return themes;
}

const BUILTINS = loadBuiltins();

interface UserThemes {
  readonly themes: ReadonlyMap<string, ThemeDefinition>;
  readonly warnings: readonly string[];
}

let themesDirectory: string | null = null;
let userThemes: UserThemes | null = null;

/**
 * Point the registry at `$JAZZ_HOME/themes`. Until this is called only the built-ins exist,
 * which keeps importing the theme module free of file reads.
 */
export function setUserThemesDirectory(directory: string | null): void {
  themesDirectory = directory;
  userThemes = null;
}

export function getUserThemesDirectory(): string | null {
  return themesDirectory;
}

function readUserThemes(directory: string): UserThemes {
  const themes = new Map<string, ThemeDefinition>();
  const warnings: string[] = [];
  let files: string[];
  try {
    files = readdirSync(directory)
      .filter((file) => file.endsWith(".json"))
      .sort();
  } catch {
    return { themes, warnings };
  }
  for (const file of files) {
    const filePath = path.join(directory, file);
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(filePath, "utf8"));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warnings.push(`${file}: not valid JSON (${reason})`);
      continue;
    }
    const result = parseThemeFile(json, filePath, PARSE_OPTIONS);
    if (!result.ok) {
      warnings.push(`${file}: ${result.errors.join("; ")}`);
      continue;
    }
    const { name } = result.theme;
    if (BUILTINS.has(name) || name === SYSTEM_THEME) {
      warnings.push(`${file}: "${name}" is a built-in theme; rename it to use your version`);
      continue;
    }
    if (themes.has(name)) {
      warnings.push(`${file}: "${name}" is already defined by another file`);
      continue;
    }
    for (const warning of legibilityWarnings(result.theme)) {
      warnings.push(`${file}: ${warning}`);
    }
    themes.set(name, result.theme);
  }
  return { themes, warnings };
}

const NO_USER_THEMES: UserThemes = { themes: new Map(), warnings: [] };

function currentUserThemes(): UserThemes {
  if (themesDirectory === null) {
    return NO_USER_THEMES;
  }
  userThemes ??= readUserThemes(themesDirectory);
  return userThemes;
}

/** Re-read the user themes directory, so a file added mid-session shows up. */
export function reloadUserThemes(): void {
  userThemes = null;
}

/** Problems found in user theme files, for `/theme` to show. */
export function userThemeWarnings(): readonly string[] {
  return currentUserThemes().warnings;
}

/** What the terminal reported about its own colours, as OpenTUI's palette query returns it. */
export interface TerminalPaletteReport {
  readonly palette: readonly (string | null)[];
  readonly defaultForeground: string | null;
  readonly defaultBackground: string | null;
}

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as [
    number,
    number,
    number,
  ];
}

/** `from` moved `amount` of the way toward `to`, per channel. */
export function blendHex(from: string, to: string, amount: number): string {
  const start = channels(from);
  const end = channels(to);
  const mixed = start.map((channel, index) =>
    Math.round(channel + ((end[index] as number) - channel) * amount),
  );
  return `#${mixed.map((channel) => channel.toString(16).padStart(2, "0").toUpperCase()).join("")}`;
}

/**
 * How far each tier steps from the ground toward the text colour. These reproduce the house
 * dark ramp: from `#0a0a0a` toward `#eeeeee`, panel `#141414` is 4% of the way, element
 * `#1e1e1e` 8.5%, the subtle rule `#282828` 13%, the rule `#3c3c3c` 21%, the active rule
 * `#606060` 37%, muted text `#808080` 52% and secondary text `#a8a8a8` 69%.
 */
export const TIER_STEPS = {
  panel: 0.04,
  element: 0.085,
  borderSubtle: 0.13,
  border: 0.21,
  borderActive: 0.37,
  muted: 0.52,
  secondary: 0.69,
} as const;

/** The ground-relative roles of a palette, re-derived from a real background and text colour. */
export function tiersOnBackground(
  colors: VariantColors,
  background: string,
  text: string = colors.selected,
): VariantColors {
  const step = (amount: number): string => blendHex(background, text, amount);
  return {
    ...colors,
    backgroundPanel: step(TIER_STEPS.panel),
    backgroundElement: step(TIER_STEPS.element),
    borderSubtle: step(TIER_STEPS.borderSubtle),
    border: step(TIER_STEPS.border),
    borderActive: step(TIER_STEPS.borderActive),
  };
}

const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;

function reportedHex(value: string | null | undefined): string | null {
  return value !== null && value !== undefined && HEX_PATTERN.test(value)
    ? value.toUpperCase()
    : null;
}

/** How far the dimmed accent steps from the accent toward the ground. */
const ACCENT_DIM_STEP = 0.25;

/**
 * The `system` theme: the terminal's own ANSI colours for every hue, its own foreground for
 * text, and a transparent ground, with the grey tiers derived from the real background. The
 * accent is ANSI cyan, the same role jazz's own accent plays.
 */
export function generateSystemTheme(
  report: TerminalPaletteReport,
  variant: ThemeVariant,
): ThemeDefinition {
  const ansi = (index: number): string =>
    reportedHex(report.palette[index]) ?? xtermIndexToHex(index);
  const house = houseTheme(variant);
  const background = reportedHex(report.defaultBackground) ?? house.background;
  const text = reportedHex(report.defaultForeground) ?? house.selected;
  const cyan = ansi(6);
  const step = (amount: number): string => blendHex(background, text, amount);
  const colors: VariantColors = tiersOnBackground(
    {
      background: TRANSPARENT,
      backgroundPanel: background,
      backgroundElement: background,
      borderSubtle: background,
      border: background,
      borderActive: background,
      selected: text,
      secondary: step(TIER_STEPS.secondary),
      muted: step(TIER_STEPS.muted),
      primary: cyan,
      accentDim: blendHex(cyan, background, ACCENT_DIM_STEP),
      agent: cyan,
      prompt: cyan,
      link: blendHex(cyan, background, ACCENT_DIM_STEP),
      reasoning: blendHex(cyan, background, ACCENT_DIM_STEP),
      info: step(TIER_STEPS.secondary),
      success: ansi(2),
      warning: ansi(3),
      error: ansi(1),
      syntaxStructure: ansi(5),
      syntaxValue: ansi(4),
      syntaxType: ansi(14),
    },
    background,
    text,
  );
  return { name: SYSTEM_THEME, label: "System", variants: { [variant]: colors }, source: "system" };
}

/**
 * Until the terminal answers, `system` is the house palette on a transparent ground, so a
 * terminal that never answers still gets a legible frame.
 */
function provisionalSystemTheme(): ThemeDefinition {
  const variants: Partial<Record<ThemeVariant, VariantColors>> = {};
  for (const variant of ["dark", "light"] as const) {
    variants[variant] = { ...houseTheme(variant), background: TRANSPARENT };
  }
  return { name: SYSTEM_THEME, label: "System", variants, source: "system" };
}

let systemTheme: ThemeDefinition | null = null;

/** Replace the `system` theme with one generated from the terminal's reported palette. */
export function setSystemTheme(theme: ThemeDefinition | null): void {
  systemTheme = theme;
}

/** Every theme: `system`, the house theme, the other built-ins, then the user's files. */
export function allThemes(): readonly ThemeDefinition[] {
  const byName = (first: ThemeDefinition, second: ThemeDefinition): number =>
    first.name.localeCompare(second.name);
  const house = BUILTINS.get(HOUSE_THEME) as ThemeDefinition;
  const otherBuiltins = [...BUILTINS.values()].filter((theme) => theme !== house).sort(byName);
  const users = [...currentUserThemes().themes.values()].sort(byName);
  return [systemTheme ?? provisionalSystemTheme(), house, ...otherBuiltins, ...users];
}

export function findTheme(name: string): ThemeDefinition | undefined {
  return allThemes().find((theme) => theme.name === name);
}

/** The house theme. Always present. */
export function houseDefinition(): ThemeDefinition {
  return BUILTINS.get(HOUSE_THEME) as ThemeDefinition;
}

/** The house theme's colours in `variant`. Always present. */
export function houseTheme(variant: ThemeVariant): VariantColors {
  return houseDefinition().variants[variant] as VariantColors;
}

/** The built-in definitions, for the legibility laws. */
export function builtinThemes(): readonly ThemeDefinition[] {
  return [...BUILTINS.values()];
}
