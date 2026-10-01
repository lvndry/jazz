/**
 * The roles a piece of shared text plays, and the one table that maps them onto the theme.
 *
 * View models (receipts, reports, plans, the status line) tag their text with a role rather
 * than a colour, so fullscreen, Ink and plain output paint the same fact the same way and a
 * theme switch reaches all of them at once. Deferred layout passes its captured
 * palette; immediate ANSI and React painting use the current theme by default.
 */

import chalk from "chalk";
import { THEME, type ThemeColors } from "../theme";

export type TextRole =
  | "label"
  | "text"
  | "strong"
  | "secondary"
  | "muted"
  | "accent"
  | "success"
  | "warning"
  | "error"
  | "border";

export interface RoleSegment {
  readonly text: string;
  readonly role: TextRole;
}

export interface RoleStyle {
  readonly fg: string;
  readonly bold?: boolean;
}

/** Color and weight in an explicit palette snapshot, or the current theme for immediate painting. */
export function roleStyle(role: TextRole, palette: Readonly<ThemeColors> = THEME): RoleStyle {
  switch (role) {
    case "label":
      return { fg: palette.secondary, bold: true };
    case "text":
      return { fg: palette.selected };
    case "strong":
      return { fg: palette.selected, bold: true };
    case "secondary":
      return { fg: palette.secondary };
    case "muted":
      return { fg: palette.muted };
    case "accent":
      return { fg: palette.primary };
    case "success":
      return { fg: palette.success };
    case "warning":
      return { fg: palette.warning };
    case "error":
      return { fg: palette.error };
    case "border":
      return { fg: palette.border };
  }
}

/** A role's text as an ANSI string, for Ink and scrollback output. */
export function paintRole(role: TextRole, text: string): string {
  const style = roleStyle(role);
  const color = chalk.hex(style.fg);
  return style.bold === true ? color.bold(text) : color(text);
}

/** Segments joined into one ANSI string. */
export function paintSegments(segments: readonly RoleSegment[]): string {
  return segments.map((segment) => paintRole(segment.role, segment.text)).join("");
}

/** Segments joined into plain text, for logs, tests and screen readers. */
export function segmentsText(segments: readonly RoleSegment[]): string {
  return segments.map((segment) => segment.text).join("");
}
