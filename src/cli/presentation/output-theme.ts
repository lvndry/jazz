import chalk from "chalk";
import type { ColorProfile, RenderTheme } from "@/core/types";
import { CHALK_THEME } from "../ui/theme";

/**
 * Display constants
 */
export const DISPLAY = {
  SEPARATOR_WIDTH: 60,
  SEPARATOR_CHAR: "─",
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
      thinking: CHALK_THEME.primaryBold,
      thinkingContent: chalk.italic.gray.dim,
      toolName: CHALK_THEME.primary,
      toolArgs: CHALK_THEME.primary,
      success: CHALK_THEME.success,
      error: chalk.red,
      warning: chalk.yellow,
      info: CHALK_THEME.primary,
      dim: chalk.dim,
      highlight: chalk.bold.white,
      agentName: CHALK_THEME.primaryBold,
    },
    icons: {
      thinking: "▸",
      tool: "▸",
      success: "✓",
      error: "✗",
      warning: "!",
      info: "i",
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
      thinking: chalk.yellowBright,
      thinkingContent: chalk.gray,
      toolName: chalk.yellowBright,
      toolArgs: chalk.yellowBright,
      success: chalk.green,
      error: chalk.red,
      warning: chalk.yellow,
      info: chalk.yellowBright,
      dim: chalk.gray,
      highlight: chalk.white,
      agentName: chalk.yellowBright,
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
