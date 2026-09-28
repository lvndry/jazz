import type { TerminalReport } from "@jazz/core/interfaces/terminal";
import chalk from "chalk";
import { getGlyphs } from "./glyphs";
import { reportLines, type ReportRole } from "./report-layout";
import { THEME } from "./theme";

function paint(role: ReportRole, text: string): string {
  switch (role) {
    case "label":
      return chalk.bold.hex(THEME.secondary)(text);
    case "text":
      return chalk.hex(THEME.selected)(text);
    case "strong":
      return chalk.bold.hex(THEME.selected)(text);
    case "secondary":
      return chalk.hex(THEME.secondary)(text);
    case "muted":
      return chalk.hex(THEME.muted)(text);
    case "accent":
      return chalk.hex(THEME.primary)(text);
    case "success":
      return chalk.hex(THEME.success)(text);
    case "warning":
      return chalk.hex(THEME.warning)(text);
    case "error":
      return chalk.hex(THEME.error)(text);
    case "border":
      return chalk.hex(THEME.border)(text);
  }
}

/** A report styled for a scrollback terminal, with the same columns every renderer uses. */
export function reportAnsiText(report: TerminalReport): string {
  return reportLines(report, getGlyphs())
    .map(
      (line) =>
        `${" ".repeat(line.indent)}${line.segments.map((segment) => paint(segment.role, segment.text)).join("")}`,
    )
    .join("\n");
}
