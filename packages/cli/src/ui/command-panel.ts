import { stripVTControlCharacters } from "node:util";
import type { TerminalReport } from "@jazz/core/interfaces/terminal";
import type { GlyphSet } from "./glyphs";
import { reportRows, wrapSegments, type ReportSegment } from "./report-layout";
import type { TextRole } from "./text/roles";

/**
 * A command that only reads (`/info`, `/cost`, `/help`, ...) answers in a panel centered over
 * the chat instead of in the transcript, so it can run while a turn is under way and leaves
 * nothing behind once Esc closes it. Both renderers draw the rows `commandPanelRows` lays out.
 */
export type CommandPanelTone = "info" | "success" | "warn" | "error" | "log";

export type CommandPanelEntry =
  | { readonly kind: "report"; readonly report: TerminalReport }
  | { readonly kind: "text"; readonly tone: CommandPanelTone; readonly text: string };

export interface CommandPanel {
  /** Which run of a command filled the panel; a later run replaces an earlier one's panel. */
  readonly id: number;
  /** The command as typed, `/info`. */
  readonly command: string;
  readonly entries: readonly CommandPanelEntry[];
}

/** The key legend a panel carries on its title row. */
export const COMMAND_PANEL_HINT = "esc to close";

const TONE_ROLE: Readonly<Record<CommandPanelTone, TextRole>> = {
  info: "text",
  success: "success",
  warn: "warning",
  error: "error",
  log: "text",
};

/** The panel's body wrapped to `width` cells, a blank row between entries. */
export function commandPanelRows(
  panel: CommandPanel,
  glyphs: GlyphSet,
  width: number,
): ReportSegment[][] {
  const rows: ReportSegment[][] = [];
  for (const entry of panel.entries) {
    if (rows.length > 0) {
      rows.push([]);
    }
    if (entry.kind === "report") {
      rows.push(...reportRows(entry.report, glyphs, width));
      continue;
    }
    for (const line of stripVTControlCharacters(entry.text).split("\n")) {
      rows.push(...wrapSegments([{ text: line, role: TONE_ROLE[entry.tone] }], Math.max(1, width)));
    }
  }
  return rows;
}
