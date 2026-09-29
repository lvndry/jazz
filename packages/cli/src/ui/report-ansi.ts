import type { TerminalReport } from "@jazz/core/interfaces/terminal";
import { getGlyphs } from "./glyphs";
import { reportStyledText } from "./report-layout";
import { paintRole } from "./text/roles";

/**
 * A report styled for a scrollback terminal, with the same columns every renderer uses,
 * wrapped under its value column when `width` is given.
 */
export function reportAnsiText(report: TerminalReport, width?: number): string {
  return reportStyledText(report, getGlyphs(), paintRole, width);
}
