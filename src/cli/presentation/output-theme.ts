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
      thinking: CHALK_THEME.agentBold,
      thinkingContent: CHALK_THEME.reasoning.italic,
      toolName: chalk.hex("#F59E0B").bold,
      toolArgs: chalk.hex("#60A5FA"),
      success: CHALK_THEME.success,
      error: CHALK_THEME.error,
      warning: CHALK_THEME.warning,
      info: CHALK_THEME.link,
      dim: CHALK_THEME.muted,
      highlight: chalk.bold.hex("#F8FAFC"),
      agentName: CHALK_THEME.agentBold,
    },
    icons: {
      thinking: "◔",
      tool: "⌁",
      success: "✔",
      error: "✖",
      warning: "⚠",
      info: "ℹ",
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
      toolArgs: chalk.cyan,
      success: chalk.greenBright,
      error: chalk.redBright,
      warning: chalk.yellowBright,
      info: chalk.cyanBright,
      dim: chalk.gray,
      highlight: chalk.whiteBright,
      agentName: chalk.cyanBright,
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
