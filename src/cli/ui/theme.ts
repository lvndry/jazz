import chalk from "chalk";

/**
 * Unified color theme constants for the Jazz CLI.
 *
 * Single source of truth for all colors used in Ink components and chalk styling.
 *
 * Ink's <Text color="..."> supports hex strings (e.g. "#DE9A2C") via chalk
 * when the terminal has truecolor support (chalk.level >= 3). On lower-level
 * terminals chalk auto-downgrades to the closest 256/16-color match.
 */
export interface ThemeColors {
  /** Primary brand accent used for prompts, selection, and key affordances. */
  primary: string;
  /** Secondary accent used for live agent identity and active surfaces. */
  agent: string;
  /** Links and code-adjacent interactive elements. */
  link: string;
  /** Success feedback. */
  success: string;
  /** Error feedback. */
  error: string;
  /** Warning feedback. */
  warning: string;
  /** Informational feedback. */
  info: string;
  /** Selected / highlighted menu items. */
  selected: string;
  /** Input prompt chevron and active cursor-adjacent accents. */
  prompt: string;
  /** Muted secondary text. */
  secondary: string;
  /** Non-selected / default text in lists. */
  muted: string;
  /** Reasoning content should feel quieter than response text, but not dead. */
  reasoning: string;
  /** Tool execution chrome. */
  toolBorder: string;
  /** Subtle surfaces and separators. */
  surface: string;
  surfaceSoft: string;
  surfaceStrong: string;
  border: string;
  borderSoft: string;
}

export type ThemeVariant = "dark" | "light";

const DARK_PALETTE: ThemeColors = {
  primary: "#DE9A2C",
  agent: "#22D3EE",
  link: "#60A5FA",
  success: "#22C55E",
  error: "#FB7185",
  warning: "#F59E0B",
  info: "#38BDF8",
  selected: "#F8FAFC",
  prompt: "#DE9A2C",
  secondary: "#94A3B8",
  muted: "#64748B",
  reasoning: "#A5B4FC",
  toolBorder: "#475569",
  surface: "#111827",
  surfaceSoft: "#1F2937",
  surfaceStrong: "#334155",
  border: "#334155",
  borderSoft: "#1F2937",
};

/** Same semantic roles tuned for light terminal backgrounds. */
const LIGHT_PALETTE: ThemeColors = {
  primary: "#B45309",
  agent: "#0E7490",
  link: "#1D4ED8",
  success: "#15803D",
  error: "#BE123C",
  warning: "#D97706",
  info: "#0369A1",
  selected: "#0F172A",
  prompt: "#B45309",
  secondary: "#475569",
  muted: "#64748B",
  reasoning: "#6366F1",
  toolBorder: "#94A3B8",
  surface: "#F1F5F9",
  surfaceSoft: "#E2E8F0",
  surfaceStrong: "#CBD5E1",
  border: "#CBD5E1",
  borderSoft: "#E2E8F0",
};

const PALETTES: Record<ThemeVariant, ThemeColors> = {
  dark: DARK_PALETTE,
  light: LIGHT_PALETTE,
};

/**
 * Resolve the theme variant: `JAZZ_THEME=light|dark` wins; otherwise the
 * terminal's advertised background via `COLORFGBG` (last field is the
 * background color index — 7/15 mean a light background); dark by default.
 */
export function resolveThemeVariant(): ThemeVariant {
  const raw = (process.env["JAZZ_THEME"] ?? "").toLowerCase();
  if (raw === "light") return "light";
  if (raw === "dark") return "dark";
  const colorFgBg = process.env["COLORFGBG"];
  if (colorFgBg) {
    const background = Number(colorFgBg.split(";").at(-1));
    if (background === 7 || background === 15) return "light";
  }
  return "dark";
}

let activeVariant: ThemeVariant = resolveThemeVariant();

/**
 * Mutable theme object — components read `THEME.x` at render time, so
 * switching variants updates everything rendered after the switch. Module
 * constants that captured a color at import time keep the old value until
 * restart (acceptable: /theme persists the choice for the next run too).
 */
export const THEME: ThemeColors = { ...PALETTES[activeVariant] };

export function getThemeVariant(): ThemeVariant {
  return activeVariant;
}

export function setThemeVariant(variant: ThemeVariant): void {
  activeVariant = variant;
  Object.assign(THEME, PALETTES[variant]);
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
} as const;

/**
 * Total horizontal chars consumed by padding, for pre-wrap width calculations.
 * = page×2 (both sides) + content (left only)
 */
export const PADDING_BUDGET = PADDING.page * 2 + PADDING.content;

/**
 * Chalk function for code/codespan colouring.
 * Adapts to the terminal's colour depth automatically.
 */
function getCodeColor(): (text: string) => string {
  if (chalk.level === 3) {
    return chalk.hex("#F59E0B");
  }
  if (chalk.level === 2) {
    return chalk.ansi256(214);
  }
  return chalk.yellowBright;
}

export const codeColor: (text: string) => string = getCodeColor();

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
