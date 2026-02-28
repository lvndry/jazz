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
  /** Warm bronze — brand color used for headers, borders, key UI */
  primary: "#DE9A2C",
  /** Links — blue to signal clickable, distinct from primary UI */
  link: "#3B82F6",
  /** Agent name throughout the lifecycle (thinking → streaming → complete) */
  agent: "#DE9A2C",
  success: "green",
  error: "red",
  warning: "yellow",
  /** Info messages, tips */
  info: "#DE9A2C",
  secondary: "gray",
  /** Selected / highlighted menu items */
  selected: "#DE9A2C",
  reasoning: "gray",
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
    return chalk.hex("#D4A054");
  }
  if (chalk.level === 2) {
    return chalk.ansi256(250);
  }
  return chalk.greenBright;
}

export const codeColor: (text: string) => string = getCodeColor();

/**
 * Chalk-based color helpers for non-Ink rendering paths.
 * Use these instead of hardcoded `chalk.blue`, `chalk.cyan`, etc.
 */
export const CHALK_THEME = {
  primary: chalk.hex(THEME.primary),
  primaryBold: chalk.hex(THEME.primary).bold,
  success: chalk.green,
  heading: chalk.bold.hex(THEME.primary),
  headingUnderline: chalk.bold.hex(THEME.primary).underline,
  link: chalk.hex(THEME.link).underline,
  secondary: chalk.dim,
  bold: chalk.bold,
  white: chalk.white,
} as const;
