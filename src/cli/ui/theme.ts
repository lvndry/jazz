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
export const THEME = {
  /** Primary brand accent used for prompts, selection, and key affordances. */
  primary: "#DE9A2C",
  /** Secondary accent used for live agent identity and active surfaces. */
  agent: "#22D3EE",
  /** Links and code-adjacent interactive elements. */
  link: "#60A5FA",
  /** Success feedback. */
  success: "#22C55E",
  /** Error feedback. */
  error: "#FB7185",
  /** Warning feedback. */
  warning: "#F59E0B",
  /** Informational feedback. */
  info: "#38BDF8",
  /** Selected / highlighted menu items. */
  selected: "#F8FAFC",
  /** Input prompt chevron and active cursor-adjacent accents. */
  prompt: "#DE9A2C",
  /** Muted secondary text. */
  secondary: "#94A3B8",
  /** Non-selected / default text in lists. */
  muted: "#64748B",
  /** Reasoning content should feel quieter than response text, but not dead. */
  reasoning: "#A5B4FC",
  /** Tool execution chrome. */
  toolBorder: "#475569",
  /** Subtle surfaces and separators. */
  surface: "#111827",
  surfaceSoft: "#1F2937",
  surfaceStrong: "#334155",
  border: "#334155",
  borderSoft: "#1F2937",
} as const;

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
 */
export const CHALK_THEME = {
  primary: chalk.hex(THEME.primary),
  primaryBold: chalk.hex(THEME.primary).bold,
  agent: chalk.hex(THEME.agent),
  agentBold: chalk.hex(THEME.agent).bold,
  reasoning: chalk.hex(THEME.reasoning),
  success: chalk.hex(THEME.success),
  error: chalk.hex(THEME.error),
  warning: chalk.hex(THEME.warning),
  heading: chalk.bold.hex(THEME.agent),
  headingUnderline: chalk.bold.hex(THEME.primary).underline,
  link: chalk.hex(THEME.link).underline,
  muted: chalk.hex(THEME.secondary),
  secondary: chalk.dim,
  bold: chalk.bold,
  white: chalk.hex(THEME.selected),
} as const;
