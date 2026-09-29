/**
 * Builds a RenderTheme (colors/styles for terminal output) for a given
 * ColorProfile, and detects which profile the current terminal supports.
 */

import type { ColorProfile, RenderTheme } from "@jazz/core/types";
import chalk from "chalk";
import { getGlyphs } from "../ui/glyphs";
import { CHALK_THEME, noColorRequested } from "../ui/theme";

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
 * The theme's colours for plain output, the same semantic tokens the
 * interactive interfaces use: the accent for the agent and its tools, the
 * neutral ramp for arguments, info and dim text, and the feedback hues only for
 * success, errors and warnings. On a 16-colour terminal chalk maps each token
 * to its nearest basic colour.
 */
function themeColors(): RenderTheme["colors"] {
  return {
    thinking: CHALK_THEME.agentBold,
    thinkingContent: CHALK_THEME.reasoning.italic,
    toolName: CHALK_THEME.primaryBold,
    toolArgs: CHALK_THEME.muted,
    success: CHALK_THEME.success,
    error: CHALK_THEME.error,
    warning: CHALK_THEME.warning,
    info: CHALK_THEME.info,
    dim: CHALK_THEME.muted,
    highlight: CHALK_THEME.white.bold,
    agentName: CHALK_THEME.agentBold,
  };
}

/**
 * Status icons from the shared glyph set, so a colour profile follows the same Unicode or
 * ASCII choice (`JAZZ_UI_GLYPHS`, terminal detection) as every other surface.
 */
function glyphIcons(): RenderTheme["icons"] {
  const glyphs = getGlyphs();
  return {
    thinking: glyphs.pending,
    tool: glyphs.arrow,
    success: glyphs.success,
    error: glyphs.error,
    warning: glyphs.warn,
    info: glyphs.info,
  };
}

/**
 * Full color theme with all features
 */
function createFullColorTheme(): RenderTheme {
  return {
    colors: themeColors(),
    icons: glyphIcons(),
    separatorWidth: DISPLAY.SEPARATOR_WIDTH,
    separatorChar: DISPLAY.SEPARATOR_CHAR,
  };
}

/**
 * Basic color theme (16 colors only)
 */
function createBasicColorTheme(): RenderTheme {
  return {
    colors: themeColors(),
    icons: glyphIcons(),
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
  if (noColorRequested() || process.env["NODE_DISABLE_COLORS"]) {
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
