/**
 * The roles a piece of shared text plays, and the one table that maps them onto the theme.
 *
 * View models (receipts, reports, plans, the status line) tag their text with a role rather
 * than a colour, so fullscreen, Ink and plain output paint the same fact the same way and a
 * theme switch reaches all of them at once.
 */

import chalk from "chalk";
import { THEME } from "../theme";

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

/** The colour and weight a role takes in the current theme; read per call so `/theme` is live. */
export function roleStyle(role: TextRole): RoleStyle {
  switch (role) {
    case "label":
      return { fg: THEME.secondary, bold: true };
    case "text":
      return { fg: THEME.selected };
    case "strong":
      return { fg: THEME.selected, bold: true };
    case "secondary":
      return { fg: THEME.secondary };
    case "muted":
      return { fg: THEME.muted };
    case "accent":
      return { fg: THEME.primary };
    case "success":
      return { fg: THEME.success };
    case "warning":
      return { fg: THEME.warning };
    case "error":
      return { fg: THEME.error };
    case "border":
      return { fg: THEME.border };
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
