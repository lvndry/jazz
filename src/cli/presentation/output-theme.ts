import chalk from "chalk";
import type { ColorProfile, RenderTheme } from "@/core/types";

/**
 * ANSI escape sequences
 */
export const ANSI = {
  MOVE_UP_1_CLEAR: "\x1b[1A\x1b[0J",
  MOVE_UP_2_CLEAR: "\x1b[2A\x1b[0J",
  MOVE_UP_3_CLEAR: "\x1b[3A\x1b[0J",
  CLEAR_LINE: "\x1b[2K",
  CURSOR_TO_START: "\x1b[0G",
} as const;

/**
 * Display constants
 */
export const DISPLAY = {
  SEPARATOR_WIDTH: 60,
  SEPARATOR_CHAR: "─",
  MAX_TOOL_ARG_LENGTH: 60,
  MAX_TOOL_RESULT_PREVIEW: 50,
} as const;

/**
 * Create a theme based on color profile
 */
export function createTheme(profile: ColorProfile): RenderTheme {
  switch (profile) {
    case "full":
      return createFullColorTheme();
    case "basic":
      return createBasicColorTheme();
    case "none":
      return createNoColorTheme();
  }
}

/**
 * Full color theme with all features
 */
function createFullColorTheme(): RenderTheme {
  return {
    colors: {
      thinking: chalk.blue.bold,
      thinkingContent: chalk.italic.gray.dim,
      toolName: chalk.cyan,
      toolArgs: chalk.cyan,
      success: chalk.green,
      error: chalk.red,
      warning: chalk.yellow,
      info: chalk.blue,
      dim: chalk.dim,
      highlight: chalk.bold.white,
      agentName: chalk.bold.blue,
    },
    icons: {
      thinking: "🧠",
      tool: "🔧",
      success: "✓",
      error: "✗",
      warning: "⚠️",
      info: "ℹ️",
    },
    separatorWidth: DISPLAY.SEPARATOR_WIDTH,
    separatorChar: DISPLAY.SEPARATOR_CHAR,
  };
}

/**
 * Basic color theme (16 colors only, no emojis)
 */
function createBasicColorTheme(): RenderTheme {
  return {
    colors: {
      thinking: chalk.blue,
      thinkingContent: chalk.gray,
      toolName: chalk.cyan,
      toolArgs: chalk.cyan,
      success: chalk.green,
      error: chalk.red,
      warning: chalk.yellow,
      info: chalk.blue,
      dim: chalk.gray,
      highlight: chalk.white,
      agentName: chalk.blue,
    },
    icons: {
      thinking: "[*]",
      tool: "[>]",
      success: "[+]",
      error: "[!]",
      warning: "[!]",
      info: "[i]",
    },
    separatorWidth: DISPLAY.SEPARATOR_WIDTH,
    separatorChar: "-",
  };
}

/**
 * No color theme (used for raw/json modes)
 */
function createNoColorTheme(): RenderTheme {
  const identity = (text: string): string => text;

  return {
    colors: {
      thinking: identity,
      thinkingContent: identity,
      toolName: identity,
      toolArgs: identity,
      success: identity,
      error: identity,
      warning: identity,
      info: identity,
      dim: identity,
      highlight: identity,
      agentName: identity,
    },
    icons: {
      thinking: "[THINKING]",
      tool: "[TOOL]",
      success: "[OK]",
      error: "[ERROR]",
      warning: "[WARNING]",
      info: "[INFO]",
    },
    separatorWidth: DISPLAY.SEPARATOR_WIDTH,
    separatorChar: "-",
  };
}

/**
 * Detect appropriate color profile based on environment
 */
export function detectColorProfile(): ColorProfile {
  // Check if colors are disabled
  if (process.env["NO_COLOR"] || process.env["NODE_DISABLE_COLORS"]) {
    return "none";
  }

  // Check if we're in a TTY
  if (!process.stdout.isTTY) {
    return "none";
  }

  // Check color support level
  const colorLevel = chalk.level;
  if (colorLevel === 0) {
    return "none";
  }
  if (colorLevel === 1) {
    return "basic";
  }

  // Full color support (256 colors or truecolor)
  return "full";
}
