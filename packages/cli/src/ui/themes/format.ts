/**
 * The theme file format: a named palette (`defs`) and the roles (`theme`) that point into it.
 * One file carries both variants — a role is either one value, or `{ "dark": …, "light": … }`.
 *
 * ```json
 * {
 *   "$schema": "https://raw.githubusercontent.com/lvndry/jazz/main/packages/cli/src/ui/themes/theme.schema.json",
 *   "name": "catppuccin",
 *   "defs": { "mochaBase": "#1e1e2e", "latteBase": "#eff1f5", "mauve": "#cba6f7" },
 *   "theme": {
 *     "background": { "dark": "mochaBase", "light": "latteBase" },
 *     "primary": "mauve"
 *   }
 * }
 * ```
 *
 * A value is a `#RRGGBB` hex string, an xterm-256 index (0–255), `"transparent"` or `"none"`
 * (the terminal's own background — background tiers only), or the name of a def or of another
 * role. References may chain; a cycle is an error. A def may also be `{ "color": …, "xterm": n }`:
 * in a terminal limited to 256 colours it paints exactly index `n` instead of whatever
 * approximation the hex would round to.
 *
 * Roles in `DERIVED_ROLES` may be left out and default to the role they name, which is how the
 * one-accent rule holds by default: `agent` and `prompt` follow `primary` unless a theme says
 * otherwise.
 */

import type { ThemeColors, ThemeVariant } from "../theme";

/** The roles a theme file sets. The `surface*`, `canvas` and old border names are derived. */
export type FileRole = Exclude<
  keyof ThemeColors,
  "canvas" | "surface" | "surfaceSoft" | "surfaceStrong" | "borderSoft" | "toolBorder"
>;

/** Background tiers, the only roles that may be the terminal's own background. */
export const BACKGROUND_ROLES: readonly FileRole[] = [
  "background",
  "backgroundPanel",
  "backgroundElement",
];

/** Every role a file can set, in the order a theme file reads best. */
export const FILE_ROLES: readonly FileRole[] = [
  "background",
  "backgroundPanel",
  "backgroundElement",
  "borderSubtle",
  "border",
  "borderActive",
  "selected",
  "secondary",
  "muted",
  "primary",
  "accentDim",
  "agent",
  "prompt",
  "link",
  "reasoning",
  "info",
  "success",
  "warning",
  "error",
  "syntaxStructure",
  "syntaxValue",
  "syntaxType",
];

/** Roles a theme may omit, each defaulting to the role it maps to. */
export const DERIVED_ROLES: Readonly<Partial<Record<FileRole, FileRole>>> = {
  agent: "primary",
  prompt: "primary",
  link: "accentDim",
  reasoning: "accentDim",
  info: "secondary",
  borderActive: "border",
};

/** A role's colour: `#RRGGBB`, or `transparent` for the terminal's own background. */
export type RoleColor = string;

export type VariantColors = Readonly<Record<FileRole, RoleColor>>;

export interface ThemeDefinition {
  readonly name: string;
  readonly label: string;
  /** The variants the file resolves to. A role without a `dark`/`light` split serves both. */
  readonly variants: Readonly<Partial<Record<ThemeVariant, VariantColors>>>;
  /** `builtin`, `system`, or the file it was read from. */
  readonly source: string;
}

export type ThemeParseResult =
  | { readonly ok: true; readonly theme: ThemeDefinition }
  | { readonly ok: false; readonly errors: readonly string[] };

export interface ParseOptions {
  /** Paint each def's `xterm` index exactly, for terminals limited to 256 colours. */
  readonly xterm256?: boolean;
}

export const TRANSPARENT = "transparent";

const FILE_ROLE_SET: ReadonlySet<string> = new Set(FILE_ROLES);
const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  "$schema",
  "name",
  "label",
  "description",
  "defs",
  "theme",
]);
const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;
const THEME_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const VARIANTS: readonly ThemeVariant[] = ["dark", "light"];

/** The 16 base colours as xterm's default palette paints them. */
const XTERM_BASE = [
  "#000000",
  "#800000",
  "#008000",
  "#808000",
  "#000080",
  "#800080",
  "#008080",
  "#C0C0C0",
  "#808080",
  "#FF0000",
  "#00FF00",
  "#FFFF00",
  "#0000FF",
  "#FF00FF",
  "#00FFFF",
  "#FFFFFF",
];
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

function toHexByte(value: number): string {
  return value.toString(16).padStart(2, "0").toUpperCase();
}

/** The hex colour xterm paints for a 256-colour index. */
export function xtermIndexToHex(index: number): string {
  if (index < 16) {
    return XTERM_BASE[index] as string;
  }
  if (index < 232) {
    const cube = index - 16;
    const red = CUBE_LEVELS[Math.floor(cube / 36)] as number;
    const green = CUBE_LEVELS[Math.floor(cube / 6) % 6] as number;
    const blue = CUBE_LEVELS[cube % 6] as number;
    return `#${toHexByte(red)}${toHexByte(green)}${toHexByte(blue)}`;
  }
  const gray = 8 + (index - 232) * 10;
  return `#${toHexByte(gray)}${toHexByte(gray)}${toHexByte(gray)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  return typeof value === "string" ? `"${value}"` : JSON.stringify(value);
}

function isXtermIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255;
}

interface Resolver {
  readonly defs: Readonly<Record<string, unknown>>;
  readonly roles: Readonly<Record<string, unknown>>;
  readonly variant: ThemeVariant;
  readonly xterm256: boolean;
}

type Resolution = { readonly color: RoleColor } | { readonly error: string };

/** Resolve one value to `#RRGGBB` or `transparent`, naming the path when it cannot. */
function resolveValue(
  value: unknown,
  path: string,
  resolver: Resolver,
  chain: readonly string[],
): Resolution {
  if (isXtermIndex(value)) {
    return { color: xtermIndexToHex(value) };
  }
  if (typeof value === "number") {
    return { error: `${path}: ${String(value)} is not an xterm-256 index (a whole number 0–255)` };
  }
  if (isRecord(value)) {
    if ("dark" in value || "light" in value) {
      if (!("dark" in value) || !("light" in value)) {
        return { error: `${path}: a variant split needs both "dark" and "light"` };
      }
      return resolveValue(value[resolver.variant], `${path}.${resolver.variant}`, resolver, chain);
    }
    if ("color" in value) {
      const fallback = value["xterm"];
      if (fallback !== undefined && !isXtermIndex(fallback)) {
        return { error: `${path}.xterm: ${describeValue(fallback)} is not an xterm-256 index` };
      }
      if (resolver.xterm256 && isXtermIndex(fallback)) {
        return { color: xtermIndexToHex(fallback) };
      }
      return resolveValue(value["color"], `${path}.color`, resolver, chain);
    }
    return {
      error: `${path}: expected a colour, a reference, { "dark", "light" } or { "color", "xterm" }`,
    };
  }
  if (typeof value !== "string") {
    return { error: `${path}: expected a "#RRGGBB" colour, an xterm index, or a name` };
  }
  if (value === TRANSPARENT || value === "none") {
    return { color: TRANSPARENT };
  }
  if (value.startsWith("#")) {
    return HEX_PATTERN.test(value)
      ? { color: value.toUpperCase() }
      : { error: `${path}: ${describeValue(value)} is not a 6-digit "#RRGGBB" colour` };
  }
  if (chain.includes(value)) {
    return { error: `${path}: reference cycle ${[...chain, value].join(" → ")}` };
  }
  if (value in resolver.defs) {
    return resolveValue(resolver.defs[value], `defs.${value}`, resolver, [...chain, value]);
  }
  if (value in resolver.roles) {
    return resolveValue(resolver.roles[value], `theme.${value}`, resolver, [...chain, value]);
  }
  return { error: `${path}: ${describeValue(value)} is not a colour, a def, or a role` };
}

/** Whether any role or def the file uses splits on variant. */
function splitsOnVariant(value: unknown): boolean {
  return isRecord(value) && ("dark" in value || "light" in value);
}

function resolveVariant(
  roles: Readonly<Record<string, unknown>>,
  resolver: Resolver,
  errors: string[],
): VariantColors | null {
  const resolved: Partial<Record<FileRole, RoleColor>> = {};
  let failed = false;
  for (const role of FILE_ROLES) {
    const derivedFrom = DERIVED_ROLES[role];
    const raw = roles[role];
    if (raw === undefined && derivedFrom !== undefined) {
      const source = resolved[derivedFrom];
      if (source === undefined) {
        failed = true;
      } else {
        resolved[role] = source;
      }
      continue;
    }
    if (raw === undefined) {
      errors.push(`theme.${role}: missing`);
      failed = true;
      continue;
    }
    const result = resolveValue(raw, `theme.${role}`, resolver, [role]);
    if ("error" in result) {
      errors.push(result.error);
      failed = true;
      continue;
    }
    if (result.color === TRANSPARENT && !BACKGROUND_ROLES.includes(role)) {
      errors.push(
        `theme.${role}: only ${BACKGROUND_ROLES.join(", ")} may be transparent; text needs a colour`,
      );
      failed = true;
      continue;
    }
    resolved[role] = result.color;
  }
  return failed ? null : (resolved as VariantColors);
}

/**
 * Which variants a file serves. A file that never splits on variant serves the one its
 * background calls for; a file that splits anywhere serves both.
 */
function servedVariants(
  roles: Readonly<Record<string, unknown>>,
  defs: Readonly<Record<string, unknown>>,
): readonly ThemeVariant[] {
  const splits = [...Object.values(roles), ...Object.values(defs)].some(splitsOnVariant);
  return splits ? VARIANTS : [];
}

/** Check a parsed theme file and resolve both variants to concrete colours. */
export function parseThemeFile(
  input: unknown,
  source: string,
  options: ParseOptions = {},
): ThemeParseResult {
  if (!isRecord(input)) {
    return { ok: false, errors: ["a theme file must be a JSON object"] };
  }
  const errors: string[] = [];
  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      errors.push(`unknown key "${key}"`);
    }
  }
  const name = input["name"];
  if (typeof name !== "string" || !THEME_NAME_PATTERN.test(name)) {
    errors.push(`name: expected lowercase letters, digits and dashes, got ${describeValue(name)}`);
  }
  const label = input["label"];
  if (label !== undefined && typeof label !== "string") {
    errors.push("label: expected a string");
  }
  const defs = input["defs"] ?? {};
  if (!isRecord(defs)) {
    errors.push("defs: expected an object of name → colour");
  }
  const roles = input["theme"];
  if (!isRecord(roles)) {
    errors.push("theme: expected an object of role → colour");
    return { ok: false, errors };
  }
  for (const key of Object.keys(roles)) {
    if (!FILE_ROLE_SET.has(key)) {
      errors.push(`theme.${key}: unknown role (roles: ${FILE_ROLES.join(", ")})`);
    }
  }
  const defTable = isRecord(defs) ? defs : {};
  const resolverFor = (variant: ThemeVariant): Resolver => ({
    defs: defTable,
    roles,
    variant,
    xterm256: options.xterm256 === true,
  });

  const variants: Partial<Record<ThemeVariant, VariantColors>> = {};
  const served = servedVariants(roles, defTable);
  if (served.length === 0) {
    const single = resolveVariant(roles, resolverFor("dark"), errors);
    if (single !== null) {
      variants[variantForBackgroundColor(single.background)] = single;
    }
  } else {
    for (const variant of served) {
      const variantErrors: string[] = [];
      const colors = resolveVariant(roles, resolverFor(variant), variantErrors);
      for (const error of variantErrors) {
        if (!errors.includes(error)) errors.push(error);
      }
      if (colors !== null) {
        variants[variant] = colors;
      }
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  const themeName = name as string;
  return {
    ok: true,
    theme: {
      name: themeName,
      label: typeof label === "string" ? label : themeName,
      variants,
      source,
    },
  };
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const fraction = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return fraction <= 0.03928 ? fraction / 12.92 : ((fraction + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** Above this relative luminance a background reads as light. */
const LIGHT_BACKGROUND_LUMINANCE = 0.4;

/** The variant a background calls for. A transparent one is taken as dark. */
export function variantForBackgroundColor(color: RoleColor): ThemeVariant {
  if (!HEX_PATTERN.test(color)) {
    return "dark";
  }
  return relativeLuminance(color) >= LIGHT_BACKGROUND_LUMINANCE ? "light" : "dark";
}

/** WCAG contrast ratio between two `#RRGGBB` colours. */
export function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/**
 * Contrast floors a user theme is warned about, not rejected for. Checked against the
 * background when it is a colour; a transparent one cannot be known ahead of time.
 */
export function legibilityWarnings(theme: ThemeDefinition): string[] {
  const checks: readonly (readonly [FileRole, number])[] = [
    ["selected", 7],
    ["secondary", 4.5],
    ["muted", 3],
    ["primary", 4.5],
    ["success", 4.5],
    ["warning", 4.5],
    ["error", 4.5],
  ];
  const warnings: string[] = [];
  for (const variant of VARIANTS) {
    const colors = theme.variants[variant];
    if (colors === undefined || colors.background === TRANSPARENT) continue;
    for (const [role, floor] of checks) {
      const ratio = contrastRatio(colors[role], colors.background);
      if (ratio < floor) {
        warnings.push(
          `${variant} ${role} is ${ratio.toFixed(1)}:1 against the background (legible text wants ${String(floor)}:1)`,
        );
      }
    }
  }
  return warnings;
}
