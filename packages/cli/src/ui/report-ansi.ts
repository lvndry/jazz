import type { TerminalReport } from "@jazz/core/interfaces/terminal";
import chalk from "chalk";
import { getGlyphs } from "./glyphs";
import { reportRoleStyle, reportStyledText, type ReportRole } from "./report-layout";

function paint(role: ReportRole, text: string): string {
  const style = reportRoleStyle(role);
  const color = chalk.hex(style.fg);
  return style.bold ? color.bold(text) : color(text);
}

/**
 * A report styled for a scrollback terminal, with the same columns every renderer uses,
 * wrapped under its value column when `width` is given.
 */
export function reportAnsiText(report: TerminalReport, width?: number): string {
  return reportStyledText(report, getGlyphs(), paint, width);
}
