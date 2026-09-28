import chalk from "chalk";
import {
  TRANSPARENT,
  variantForBackgroundColor,
  type ThemeDefinition,
  type VariantColors,
} from "./themes/format";
import {
  allThemes,
  findTheme,
  generateSystemTheme,
  HOUSE_THEME,
  houseDefinition,
  houseTheme,
  reloadUserThemes,
  reportIsUsable,
  setSystemTheme,
  setUserThemesDirectory,
  SYSTEM_THEME,
  tiersOnBackground,
  userThemeWarnings,
  type TerminalPaletteReport,
} from "./themes/registry";

/**
 * Colour is semantics.
 *
 * Every hue here answers one question a reader actually asks — who is
 * speaking, is this a tool, did it work, should I worry, is this about to
 * touch my real accounts. Six hues is the budget, because six is a set you
 * can hold in your head: after an hour in the app you read colour without
 * deciding to. Everything else — headings, rules, borders, labels,
 * timestamps, paths — lives on the neutral ramp, and emphasis comes from
 * stroke weight, rule weight and shade rather than from adding a hue.
 *
 * There is deliberately ONE accent. The speaker is distinguished by the
 * marker glyph (`»` for you, `╶` for the agent), not by giving each party
 * its own colour — so the accent means "live" wherever it appears.
 *
 * There is deliberately no green in the syntax colours, so success green
 * keeps a single unambiguous meaning.
 *
 * The values come from theme files (`themes/builtin/*.json`, or the user's
 * own in `$JAZZ_HOME/themes`); the built-ins are held to the legibility laws
 * in `theme.test.ts`.
 */
export interface ThemeColors {
  /**
   * The ground to paint a full window with: a colour in `painted` mode, `transparent` when the
   * terminal's own background shows through. A paint value, not something to draw on.
   */
  background: string;
  /** A raised tier: your messages, the approval card, overlays. */
  backgroundPanel: string;
  /** The next tier up: code blocks, the input box, menus. */
  backgroundElement: string;
  /** The quietest rule. */
  borderSubtle: string;
  /** Rules and frames. */
  border: string;
  /** A focused frame. */
  borderActive: string;
  /** The ground as a real colour — what anything drawn on the ground sits on. Always opaque. */
  canvas: string;
  /** Primary accent — live, and the user's own affordances. */
  primary: string;
  /** Live agent identity. Same accent: the glyph says who, the colour says live. */
  agent: string;
  /** Dimmed accent — subordinate live content, links, citations. */
  accentDim: string;
  /** Links and code-adjacent interactive elements. */
  link: string;
  /** Success feedback. */
  success: string;
  /** Error feedback. */
  error: string;
  /** Warning feedback — a scope worth noticing, never a failure. */
  warning: string;
  /** Informational feedback. Sits on the neutral ramp; info is not a hue. */
  info: string;
  /** Primary text. */
  selected: string;
  /** Input prompt marker and active cursor-adjacent accents. */
  prompt: string;
  /** Secondary text. */
  secondary: string;
  /** Dim text — metadata, settled receipts, timestamps. */
  muted: string;
  /** Reasoning is live but subordinate to an answer. */
  reasoning: string;
  /** Pre-tier name for `borderSubtle`. */
  toolBorder: string;
  /** Pre-tier name for `backgroundPanel`, always opaque. */
  surface: string;
  /** Pre-tier name for `backgroundPanel`, always opaque. */
  surfaceSoft: string;
  /** Pre-tier name for `backgroundElement`, always opaque. */
  surfaceStrong: string;
  /** Pre-tier name for `borderSubtle`. */
  borderSoft: string;
  /** Syntax: keywords and structure. */
  syntaxStructure: string;
  /** Syntax: strings, numbers, and inline code. */
  syntaxValue: string;
  /** Syntax: types and constructors. */
  syntaxType: string;
}

export type ThemeVariant = "dark" | "light";

/**
 * Whether the window's ground is the terminal's own background or the theme's.
 *
 * `inherit` leaves the ground unpainted: empty cells show whatever the terminal already has, and
 * only the panel and element tiers (your messages, code, overlays, menus) are painted. When the
 * terminal answers the background query, those tiers and the rules are re-derived from the real
 * background, so a band sits one quiet step off the ground the user actually sees. A theme
 * variant that does not suit the terminal's ground (light on a dark terminal) is painted anyway,
 * because its text was chosen for its own background. `painted` paints every cell with the
 * theme's background and sets the terminal's default background to match for as long as jazz
 * owns the screen.
 */
export type CanvasMode = "inherit" | "painted";

/** Exported so `scripts/gen-design-docs.ts` and the website can document the house values. */
export const PALETTES: Record<ThemeVariant, ThemeColors> = {
  dark: toThemeColors(houseTheme("dark"), houseTheme("dark").background),
  light: toThemeColors(houseTheme("light"), houseTheme("light").background),
};

/**
 * The palette a component reads, from a resolved variant.
 *
 * `canvas` is always a real colour — the best knowledge of the ground, used where a colour has
 * to sit *on* it (a cursor's glyph, contrast checks). `background` is what to paint the ground
 * with, and is `transparent` whenever the terminal's own background shows through. The
 * `surface*`, `borderSoft` and `toolBorder` keys are the pre-tier names, filled from the tiers
 * until every call site uses the tier names.
 */
function toThemeColors(colors: VariantColors, canvas: string): ThemeColors {
  const opaque = (color: string): string => (color === TRANSPARENT ? canvas : color);
  return {
    ...colors,
    canvas,
    surface: opaque(colors.backgroundPanel),
    surfaceSoft: opaque(colors.backgroundPanel),
    surfaceStrong: opaque(colors.backgroundElement),
    borderSoft: colors.borderSubtle,
    toolBorder: colors.borderSubtle,
  };
}

/**
 * Whether the user asked for no colour: `NO_COLOR` set to anything but the
 * empty string, per https://no-color.org.
 */
export function noColorRequested(environment: NodeJS.ProcessEnv = process.env): boolean {
  const value = environment["NO_COLOR"];
  return value !== undefined && value !== "";
}

/**
 * A palette with every hue replaced by the neutral ramp, for `NO_COLOR`.
 *
 * Roles keep their place on the ramp (primary text, secondary text, muted
 * metadata) and grounds and rules keep theirs, so emphasis still comes from
 * weight and shade. The fullscreen interface paints cells with these; the
 * classic interface and plain output get no colour at all, because chalk is
 * switched off (see `applyNoColor`).
 */
export function neutralPalette(palette: ThemeColors): ThemeColors {
  return {
    ...palette,
    primary: palette.selected,
    agent: palette.selected,
    accentDim: palette.secondary,
    link: palette.secondary,
    success: palette.selected,
    error: palette.selected,
    warning: palette.selected,
    info: palette.secondary,
    prompt: palette.selected,
    reasoning: palette.secondary,
    syntaxStructure: palette.selected,
    syntaxValue: palette.secondary,
    syntaxType: palette.selected,
  };
}

const colorDisabled = noColorRequested();

/**
 * Turn chalk's colour off when `NO_COLOR` is set. Ink renders through the same
 * chalk instance, so this covers the classic interface, the plain presentation,
 * and every `CHALK_THEME` helper. Runs once, when this module loads.
 */
function applyNoColor(): void {
  if (colorDisabled) {
    chalk.level = 0;
  }
}

applyNoColor();

/** What a person asked for: a theme, a variant, or both. Missing parts are worked out. */
export interface ThemeSelection {
  readonly name?: string;
  readonly variant?: ThemeVariant;
}

function isVariant(part: string | undefined): part is ThemeVariant {
  return part === "dark" || part === "light";
}

/**
 * Read `jazz`, `jazz:light`, `jazz light` or a bare `light`/`dark`. Returns null for an empty
 * or malformed value.
 */
export function parseThemeSelection(raw: string): ThemeSelection | null {
  const parts = raw
    .trim()
    .toLowerCase()
    .split(/[\s:]+/)
    .filter((part) => part.length > 0);
  if (parts.length === 1) {
    const only = parts[0] as string;
    return isVariant(only) ? { variant: only } : { name: only };
  }
  if (parts.length === 2 && isVariant(parts[1])) {
    return { name: parts[0] as string, variant: parts[1] };
  }
  return null;
}

/** The `ui.theme` value for a selection: `name`, or `name:variant` when a variant is pinned. */
export function formatThemeSelection(selection: ThemeSelection, fallbackName: string): string {
  const name = selection.name ?? fallbackName;
  return selection.variant === undefined ? name : `${name}:${selection.variant}`;
}

/** The variant `COLORFGBG` advertises: its last field is the background index, 7 and 15 are light. */
export function variantFromColorFgBg(colorFgBg: string | undefined): ThemeVariant | undefined {
  if (colorFgBg === undefined || colorFgBg === "") {
    return undefined;
  }
  const background = Number(colorFgBg.split(";").at(-1));
  return background === 7 || background === 15 ? "light" : "dark";
}

interface ThemeState {
  /** What the user chose, from `/theme`, `JAZZ_THEME` or `ui.theme`. */
  committed: ThemeSelection;
  /** What is showing while a picker previews, or null. */
  preview: ThemeSelection | null;
  canvasMode: CanvasMode;
  /** The terminal's background, when it answered the query. */
  terminalBackground: string | null;
  /** The variant `COLORFGBG` points to, for when the terminal never answers. */
  environmentVariant: ThemeVariant;
  active: { readonly definition: ThemeDefinition; readonly variant: ThemeVariant };
  revision: number;
}

function selectionFromEnvironment(): ThemeSelection {
  const raw = process.env["JAZZ_THEME"];
  return raw === undefined ? {} : (parseThemeSelection(raw) ?? {});
}

const state: ThemeState = {
  committed: selectionFromEnvironment(),
  preview: null,
  canvasMode: "inherit",
  terminalBackground: null,
  environmentVariant: variantFromColorFgBg(process.env["COLORFGBG"]) ?? "dark",
  active: { definition: houseDefinition(), variant: "dark" },
  revision: 0,
};

/** The theme shown when nothing is chosen: the terminal's own in `inherit`, the house one painted. */
function defaultThemeName(): string {
  return state.canvasMode === "inherit" ? SYSTEM_THEME : HOUSE_THEME;
}

function detectedVariant(): ThemeVariant {
  return state.terminalBackground === null
    ? state.environmentVariant
    : variantForBackgroundColor(state.terminalBackground);
}

function resolveSelection(selection: ThemeSelection): ThemeState["active"] {
  const definition = findTheme(selection.name ?? defaultThemeName()) ?? houseDefinition();
  const wanted = selection.variant ?? detectedVariant();
  const variant =
    definition.variants[wanted] !== undefined ? wanted : wanted === "dark" ? "light" : "dark";
  return { definition, variant };
}

/**
 * Whether the ground is painted. Always in `painted` mode. In `inherit` mode only when the
 * terminal's own background would not suit the variant on screen — a light theme pinned on a
 * dark terminal would otherwise put dark text on a dark ground.
 */
function groundIsPaintedFor(active: ThemeState["active"]): boolean {
  return state.canvasMode === "painted" || active.variant !== detectedVariant();
}

function paletteOf(active: ThemeState["active"]): ThemeColors {
  const colors = active.definition.variants[active.variant] as VariantColors;
  const known = state.terminalBackground;
  const inherit = !groundIsPaintedFor(active);
  const opaqueBackground =
    colors.background === TRANSPARENT ? (known ?? houseTheme(active.variant).background) : null;
  let painted: ThemeColors;
  if (inherit) {
    const canvas = known ?? opaqueBackground ?? colors.background;
    const tiers = known === null ? colors : tiersOnBackground(colors, known);
    painted = toThemeColors({ ...tiers, background: TRANSPARENT }, canvas);
  } else {
    const background = opaqueBackground ?? colors.background;
    painted = toThemeColors({ ...colors, background }, background);
  }
  return colorDisabled ? neutralPalette(painted) : painted;
}

/**
 * Mutable theme object — components read `THEME.x` at render time, so a switch reaches
 * everything rendered after it. Components that memoise their output also read the revision
 * (`getThemeRevision`, or `useThemeRevision` in the fullscreen interface), which is what makes a
 * switch repaint the frame already on screen.
 */
export const THEME: ThemeColors = { ...PALETTES.dark };

const listeners = new Set<() => void>();

function repaint(): void {
  state.active = resolveSelection(state.preview ?? state.committed);
  Object.assign(THEME, paletteOf(state.active));
  state.revision++;
  for (const listener of listeners) {
    listener();
  }
}

repaint();

/** Subscribe to every palette change. Returns the unsubscribe. */
export function onThemeChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Increments on every palette change, so memoised output can key on it. */
export function getThemeRevision(): number {
  return state.revision;
}

export function getThemeVariant(): ThemeVariant {
  return state.active.variant;
}

/** The name of the theme on screen, including a preview. */
export function getThemeName(): string {
  return state.active.definition.name;
}

/** Switch variant within the current theme. */
export function setThemeVariant(variant: ThemeVariant): void {
  state.committed = { name: state.active.definition.name, variant };
  state.preview = null;
  repaint();
}

export function getCanvasMode(): CanvasMode {
  return state.canvasMode;
}

export function setCanvasMode(mode: CanvasMode): void {
  if (state.canvasMode === mode) return;
  state.canvasMode = mode;
  repaint();
}

/** Whether the ground on screen is painted rather than the terminal's own; see `CanvasMode`. */
export function groundIsPainted(): boolean {
  return groundIsPaintedFor(state.active);
}

/**
 * What a full-window ground paints: `transparent` while the terminal's own background shows,
 * and the theme's background while it is painted. Overlays and bands that must hide what is
 * behind them paint `THEME.canvas` or a tier instead.
 */
export function groundPaint(): string {
  return THEME.background;
}

/**
 * Record the terminal's background from its answer to the OSC 11 query, or null when it never
 * answered. Drives the variant when nothing pins one, and the derived tiers in `inherit` mode.
 */
export function setTerminalBackground(hex: string | null): void {
  const normalized = hex === null ? null : hex.toUpperCase();
  if (state.terminalBackground === normalized) return;
  state.terminalBackground = normalized;
  repaint();
}

export function getTerminalBackground(): string | null {
  return state.terminalBackground;
}

/**
 * Regenerate the `system` theme from the terminal's reported palette, and record its
 * background. Safe to call with a partial report: missing colours fall back to xterm's.
 */
export function applyTerminalPalette(report: TerminalPaletteReport): void {
  if (!reportIsUsable(report)) return;
  const background = report.defaultBackground;
  const variant =
    background === null ? state.environmentVariant : variantForBackgroundColor(background);
  setSystemTheme(generateSystemTheme(report, variant));
  state.terminalBackground = background === null ? null : background.toUpperCase();
  repaint();
}

/** What the last `initializeTheme` could not honour, kept for `/theme` to show. */
let startupWarnings: readonly string[] = [];

function themeExists(name: string): boolean {
  return findTheme(name) !== undefined;
}

/**
 * Apply the configured theme at startup. `JAZZ_THEME` beats `ui.theme`; an unknown name falls
 * back to the default and is reported rather than thrown, so a typo never stops jazz.
 */
export function initializeTheme(options: {
  readonly configured?: string;
  readonly canvas?: CanvasMode;
  /** `$JAZZ_HOME/themes`, where the user's own theme files live. */
  readonly themesDirectory?: string;
}): readonly string[] {
  if (options.themesDirectory !== undefined) {
    setUserThemesDirectory(options.themesDirectory);
  }
  const warnings: string[] = [];
  const fromEnvironment = process.env["JAZZ_THEME"];
  const raw = fromEnvironment ?? options.configured;
  let selection: ThemeSelection = {};
  if (raw !== undefined) {
    const parsed = parseThemeSelection(raw);
    const source = fromEnvironment === undefined ? "ui.theme" : "JAZZ_THEME";
    if (parsed === null) {
      warnings.push(`${source} "${raw}" is not a theme; using the default`);
    } else if (parsed.name !== undefined && !themeExists(parsed.name)) {
      warnings.push(`${source} names an unknown theme "${parsed.name}"; using the default`);
      selection = parsed.variant === undefined ? {} : { variant: parsed.variant };
    } else {
      selection = parsed;
    }
  }
  state.committed = selection;
  state.preview = null;
  state.canvasMode = options.canvas ?? "inherit";
  startupWarnings = warnings;
  repaint();
  return warnings;
}

/** One row of `/theme` or a theme picker. */
export interface ThemeListing {
  /** `name:variant`, accepted by `applyTheme` and `previewTheme`. */
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly variant: ThemeVariant;
  /** `builtin`, `system`, or the file it was read from. */
  readonly source: string;
  readonly current: boolean;
  /** The theme's own accent, success, warning, error and keyword colours, for a picker to show. */
  readonly swatches: readonly string[];
}

/** The roles a theme is recognised by at a glance: its accent, then its status hues and keywords. */
const SWATCH_ROLES = ["primary", "success", "warning", "error", "syntaxStructure"] as const;

/** Every theme and variant, with the committed one marked. Re-reads the user themes directory. */
export function listThemes(): readonly ThemeListing[] {
  reloadUserThemes();
  const committed = resolveSelection(state.committed);
  const listings: ThemeListing[] = [];
  for (const definition of allThemes()) {
    for (const variant of ["dark", "light"] as const) {
      const colors = definition.variants[variant];
      if (colors === undefined) continue;
      listings.push({
        id: `${definition.name}:${variant}`,
        name: definition.name,
        label: definition.label,
        variant,
        source: definition.source,
        current: definition.name === committed.definition.name && variant === committed.variant,
        swatches: SWATCH_ROLES.map((role) => colors[role]),
      });
    }
  }
  return listings;
}

/** Problems with the user's theme files, for `/theme` to show. */
export function themeWarnings(): readonly string[] {
  return [...startupWarnings, ...userThemeWarnings()];
}

export type ThemeChangeResult =
  | {
      readonly ok: true;
      readonly name: string;
      readonly label: string;
      readonly variant: ThemeVariant;
      /** The `ui.theme` value that reproduces this choice. */
      readonly setting: string;
    }
  | { readonly ok: false; readonly error: string };

function selectionFor(raw: string): ThemeSelection | string {
  const parsed = parseThemeSelection(raw);
  if (parsed === null) {
    return `"${raw}" is not a theme name`;
  }
  if (parsed.name === undefined) {
    const variant = parsed.variant as ThemeVariant;
    const current = state.active.definition;
    return { name: current.variants[variant] === undefined ? HOUSE_THEME : current.name, variant };
  }
  if (!themeExists(parsed.name)) {
    return `no theme named "${parsed.name}"`;
  }
  return parsed;
}

function changeResult(selection: ThemeSelection): ThemeChangeResult {
  return {
    ok: true,
    name: state.active.definition.name,
    label: state.active.definition.label,
    variant: state.active.variant,
    setting: formatThemeSelection(selection, state.active.definition.name),
  };
}

/** Commit a theme: `name`, `name:variant`, `name variant`, or `light`/`dark` within the theme. */
export function applyTheme(raw: string): ThemeChangeResult {
  const selection = selectionFor(raw);
  if (typeof selection === "string") {
    return { ok: false, error: selection };
  }
  state.committed = selection;
  state.preview = null;
  repaint();
  return changeResult(selection);
}

/** Show a theme without committing it; `revertPreview` returns to the committed one. */
export function previewTheme(raw: string): ThemeChangeResult {
  const selection = selectionFor(raw);
  if (typeof selection === "string") {
    return { ok: false, error: selection };
  }
  state.preview = selection;
  repaint();
  return changeResult(selection);
}

export function revertPreview(): void {
  if (state.preview === null) return;
  state.preview = null;
  repaint();
}

/**
 * Unified spacing constants for the Jazz CLI.
 *
 * Single source of truth for all padding/indentation used in Ink components.
 * Every Box that adds horizontal padding should reference these values so the
 * whole UI has consistent left-alignment.
 *
 * Layout hierarchy (left side):
 *   App paddingX = page (2)       → 2 chars left
 *     content paddingLeft = content (2) → +2 chars (tool calls, activity, stream text)
 *       nested paddingLeft = nested (4) → +2 more (multi-line tool results, todo lists)
 *
 * Total horizontal padding budget:
 *   page×2 = 4 chars (both sides from App)
 *   + content = 2 chars (left, inner content)
 *   = 6 chars on the left for most content
 */
export const PADDING = {
  /** Outer page padding (paddingX on the main App container) */
  page: 2,
  /** Content-level left indent (tool calls, stream text, activity phases) */
  content: 2,
  /** Deeply nested content (todo snapshots, multi-line tool results) */
  nested: 4,
} as const;

/**
 * Standardized vertical spacing between UI sections.
 * Use these instead of ad-hoc marginTop/marginBottom values.
 */
export const SPACING = {
  /** Gap between major sections (e.g. after header, between prompt and output) */
  section: 1,
  /** Gap between sub-items within a section (e.g. between menu items and tips) */
  item: 1,
  /** Tight gap for live status rows and compact cards. */
  compact: 0,
} as const;

/**
 * Motion timing constants used for subtle UX feedback.
 */
export const MOTION = {
  instant: 0,
  quick: 90,
  standard: 140,
  gentle: 180,
  /**
   * Frame interval for the activity indicator. Deliberately slow: terminals
   * that buffer a synchronized frame allocate per frame, and the fastest
   * host TUIs are invalidation-driven on a ~250ms heartbeat rather than
   * running an animation loop at all. Nothing here needs to beat 12fps, and
   * a calmer indicator is easier to sit beside for three minutes.
   */
  indicator: 170,
} as const;

/**
 * Total horizontal chars consumed by padding, for pre-wrap width calculations.
 * = page×2 (both sides) + content (left only)
 */
export const PADDING_BUDGET = PADDING.page * 2 + PADDING.content;

/**
 * Chalk function for code/codespan colouring.
 *
 * Resolved per call rather than baked at import, so `/theme` switches it like
 * everything else. It reads `syntaxValue` — the same tint strings and numbers
 * get inside a fenced block — which keeps inline code distinct from both the
 * accent and the warning hue. Previously all three were the same amber, which
 * is why a bulleted list with bold text rendered as a wall of orange.
 */
export const codeColor = (text: string): string => chalk.hex(THEME.syntaxValue)(text);

/**
 * Chalk-based color helpers for non-Ink rendering paths.
 * Use these instead of hardcoded `chalk.blue`, `chalk.cyan`, etc.
 *
 * Getters (not baked instances) so each access reads the CURRENT palette —
 * this is what lets /theme switch light/dark without rebuilding consumers.
 * Each returned value is a real chalk instance, so chaining
 * (`CHALK_THEME.reasoning.italic`) and passing as a function both work.
 */
export const CHALK_THEME = {
  get primary() {
    return chalk.hex(THEME.primary);
  },
  get primaryBold() {
    return chalk.hex(THEME.primary).bold;
  },
  get agent() {
    return chalk.hex(THEME.agent);
  },
  get agentBold() {
    return chalk.hex(THEME.agent).bold;
  },
  get reasoning() {
    return chalk.hex(THEME.reasoning);
  },
  get success() {
    return chalk.hex(THEME.success);
  },
  get error() {
    return chalk.hex(THEME.error);
  },
  get warning() {
    return chalk.hex(THEME.warning);
  },
  get heading() {
    return chalk.bold.hex(THEME.agent);
  },
  get headingUnderline() {
    return chalk.bold.hex(THEME.primary).underline;
  },
  get link() {
    return chalk.hex(THEME.link).underline;
  },
  get muted() {
    return chalk.hex(THEME.secondary);
  },
  get info() {
    return chalk.hex(THEME.info);
  },
  get secondary() {
    return chalk.dim;
  },
  get bold() {
    return chalk.bold;
  },
  get white() {
    return chalk.hex(THEME.selected);
  },
} as const;
