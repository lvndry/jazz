import type {
  ReportMarker,
  ReportRow,
  ReportTone,
  TerminalReport,
} from "@jazz/core/interfaces/terminal";
import type { GlyphSet } from "./glyphs";
import { contextPercent, meterFilledCells, meterTone } from "./meter";

/**
 * How a command report reads, independent of any terminal: jazz speaking, not the agent.
 *
 *    context   82k of 200k   ━━━━━━━━────────────  41%
 *              system        9k
 *              tools        12k
 *              compacts at 80%
 *
 * The command's name sits in a label column on the first row and every other row hangs
 * under the value column, so a report never borrows the agent's speaker marker. Keys are
 * muted and aligned within each run of fields; numbers in a run right-align so their
 * digits line up. Each renderer maps the roles below onto its own colours.
 */
export type ReportRole =
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

export interface ReportSegment {
  readonly text: string;
  readonly role: ReportRole;
}

export interface ReportLine {
  /** Columns before the content: the label column on every row. */
  readonly indent: number;
  readonly segments: readonly ReportSegment[];
}

/** Cells between the label and the value column, and between aligned columns. */
const COLUMN_GAP = 3;
/** The label column never gets narrower than this, so short names still leave air. */
const MIN_LABEL_COLUMN = 10;
/** A report meter is long enough to read a proportion from, short enough to sit on one row. */
export const REPORT_METER_CELLS = 20;

const NUMERIC_VALUE = /^[~≈$-]?\d/;

function toneRole(tone: ReportTone | undefined, fallback: ReportRole): ReportRole {
  return tone === undefined ? fallback : tone;
}

function markerSegment(marker: ReportMarker, glyphs: GlyphSet): ReportSegment {
  switch (marker) {
    case "current":
      return { text: glyphs.arrow, role: "accent" };
    case "active":
      return { text: glyphs.active, role: "success" };
    case "inactive":
      return { text: glyphs.pending, role: "muted" };
    case "attention":
      return { text: glyphs.warn, role: "warning" };
    case "disabled":
      return { text: glyphs.laneEnd, role: "muted" };
  }
}

type Run =
  | { readonly kind: "fields"; readonly rows: readonly Extract<ReportRow, { kind: "field" }>[] }
  | { readonly kind: "items"; readonly rows: readonly Extract<ReportRow, { kind: "item" }>[] }
  | { readonly kind: "single"; readonly row: ReportRow };

/** Consecutive fields align with each other, and so do consecutive items. */
function runsOf(rows: readonly ReportRow[]): Run[] {
  const runs: Run[] = [];
  for (const row of rows) {
    const last = runs.at(-1);
    if (row.kind === "field") {
      if (last?.kind === "fields") {
        runs[runs.length - 1] = { kind: "fields", rows: [...last.rows, row] };
      } else {
        runs.push({ kind: "fields", rows: [row] });
      }
    } else if (row.kind === "item") {
      if (last?.kind === "items") {
        runs[runs.length - 1] = { kind: "items", rows: [...last.rows, row] };
      } else {
        runs.push({ kind: "items", rows: [row] });
      }
    } else {
      runs.push({ kind: "single", row });
    }
  }
  return runs;
}

function fieldLines(rows: readonly Extract<ReportRow, { kind: "field" }>[]): ReportSegment[][] {
  const keyWidth = Math.max(...rows.map((row) => [...row.key].length));
  const numeric = rows.every((row) => NUMERIC_VALUE.test(row.value));
  const valueWidth = Math.max(...rows.map((row) => [...row.value].length));
  return rows.map((row) => {
    const value = numeric ? row.value.padStart(valueWidth) : row.value;
    const segments: ReportSegment[] = [
      { text: row.key.padEnd(keyWidth + COLUMN_GAP), role: "muted" },
      { text: value, role: toneRole(row.tone, "text") },
    ];
    if (row.detail !== undefined && row.detail.length > 0) {
      segments.push({ text: `  ${row.detail}`, role: "muted" });
    }
    return segments;
  });
}

function itemLines(
  rows: readonly Extract<ReportRow, { kind: "item" }>[],
  glyphs: GlyphSet,
): ReportSegment[][] {
  const marked = rows.some((row) => row.marker !== undefined);
  const nameWidth = Math.max(...rows.map((row) => [...row.name].length));
  const detailed = rows.some((row) => row.detail !== undefined && row.detail.length > 0);
  return rows.map((row) => {
    const segments: ReportSegment[] = [];
    if (marked) {
      segments.push(
        row.marker === undefined ? { text: " ", role: "muted" } : markerSegment(row.marker, glyphs),
        { text: " ", role: "muted" },
      );
    }
    const nameRole: ReportRole =
      row.tone !== undefined
        ? row.tone
        : row.marker === "current"
          ? "strong"
          : row.marker === "disabled"
            ? "muted"
            : "text";
    const name = detailed ? row.name.padEnd(nameWidth + COLUMN_GAP) : row.name;
    segments.push({ text: name, role: nameRole });
    if (row.detail !== undefined && row.detail.length > 0) {
      segments.push({ text: row.detail, role: "muted" });
    }
    return segments;
  });
}

function singleLine(row: ReportRow, glyphs: GlyphSet): ReportSegment[] {
  switch (row.kind) {
    case "group":
      return row.count === undefined
        ? [{ text: row.label, role: "strong" }]
        : [
            { text: row.label, role: "strong" },
            { text: `  ${row.count}`, role: "muted" },
          ];
    case "text":
      return [{ text: row.text, role: toneRole(row.tone, "text") }];
    case "meter": {
      const percent = contextPercent(row.used, row.total);
      const filled = meterFilledCells(percent, REPORT_METER_CELLS);
      return [
        { text: row.caption, role: "text" },
        { text: " ".repeat(COLUMN_GAP), role: "muted" },
        { text: glyphs.ruleHeavy.repeat(filled), role: meterTone(percent) },
        { text: glyphs.ruleHeavy.repeat(REPORT_METER_CELLS - filled), role: "border" },
        { text: `  ${String(percent)}%`, role: "muted" },
      ];
    }
    case "gap":
      return [];
    case "field":
    case "item":
      return [];
  }
}

/** Lay a report out as lines of role-tagged segments, the label on the first line. */
export function reportLines(report: TerminalReport, glyphs: GlyphSet): ReportLine[] {
  const indent = Math.max(MIN_LABEL_COLUMN, [...report.label].length + COLUMN_GAP);
  const bodies: ReportSegment[][] = [];
  for (const run of runsOf(report.rows)) {
    if (run.kind === "fields") {
      bodies.push(...fieldLines(run.rows));
    } else if (run.kind === "items") {
      bodies.push(...itemLines(run.rows, glyphs));
    } else {
      bodies.push(singleLine(run.row, glyphs));
    }
  }
  if (report.note !== undefined && report.note.length > 0) {
    if (bodies.length > 0) {
      bodies.push([]);
    }
    bodies.push([{ text: report.note, role: "muted" }]);
  }
  if (bodies.length === 0) {
    bodies.push([]);
  }

  return bodies.map((segments, index) =>
    index === 0
      ? {
          indent: 0,
          segments: [{ text: report.label.padEnd(indent), role: "label" }, ...segments],
        }
      : { indent, segments },
  );
}

/**
 * Break one line's segments into rows at most `width` cells wide, at spaces where it can and
 * mid-word only when a word alone is wider than the row. Roles carry over to every piece.
 */
function wrapSegments(segments: readonly ReportSegment[], width: number): ReportSegment[][] {
  const rows: ReportSegment[][] = [[]];
  let used = 0;
  const push = (text: string, role: ReportRole): void => {
    const row = rows[rows.length - 1] as ReportSegment[];
    const last = row.at(-1);
    if (last !== undefined && last.role === role) {
      row[row.length - 1] = { text: last.text + text, role };
    } else {
      row.push({ text, role });
    }
    used += [...text].length;
  };
  const breakRow = (): void => {
    const row = rows[rows.length - 1] as ReportSegment[];
    const last = row.at(-1);
    if (last !== undefined) {
      row[row.length - 1] = { ...last, text: last.text.trimEnd() };
    }
    rows.push([]);
    used = 0;
  };
  for (const segment of segments) {
    for (const piece of segment.text.split(/(?<= )/)) {
      let rest = piece;
      while ([...rest].length > 0) {
        const room = width - used;
        const length = [...rest].length;
        if (length <= room || [...rest.trimEnd()].length <= room) {
          push(rest, segment.role);
          break;
        }
        if (used > 0 && length <= width) {
          breakRow();
          continue;
        }
        const head = [...rest].slice(0, Math.max(1, room)).join("");
        push(head, segment.role);
        rest = [...rest].slice([...head].length).join("");
        breakRow();
      }
    }
  }
  return rows;
}

function textOf(
  report: TerminalReport,
  glyphs: GlyphSet,
  width: number | undefined,
  paint: (segment: ReportSegment) => string,
): string {
  const lines = reportLines(report, glyphs);
  const labelColumn = [...(lines[0]?.segments[0]?.text ?? "")].length;
  const out: string[] = [];
  lines.forEach((line, index) => {
    const head = index === 0 ? line.segments.slice(0, 1) : [];
    const body = index === 0 ? line.segments.slice(1) : line.segments;
    const indent = index === 0 ? 0 : line.indent;
    const rows =
      width === undefined || width <= labelColumn
        ? [body]
        : wrapSegments(body, Math.max(1, width - labelColumn));
    rows.forEach((row, rowIndex) => {
      const lead =
        rowIndex === 0
          ? `${" ".repeat(indent)}${head.map(paint).join("")}`
          : " ".repeat(labelColumn);
      out.push(`${lead}${row.map(paint).join("")}`.trimEnd());
    });
  });
  return out.join("\n");
}

/** The report as plain text for pipes, logs, persisted history and bots, wrapped when `width` is given. */
export function reportPlainText(report: TerminalReport, glyphs: GlyphSet, width?: number): string {
  return textOf(report, glyphs, width, (segment) => segment.text);
}

/** The report as text with each segment styled by `paint`, wrapped when `width` is given. */
export function reportStyledText(
  report: TerminalReport,
  glyphs: GlyphSet,
  paint: (role: ReportRole, text: string) => string,
  width?: number,
): string {
  return textOf(report, glyphs, width, (segment) => paint(segment.role, segment.text));
}
