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
  link: chalk.hex(THEME.primary).underline,
  secondary: chalk.dim,
  bold: chalk.bold,
  white: chalk.white,
} as const;
