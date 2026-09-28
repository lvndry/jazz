import type { TableAlign } from "./parse";
import { sameMarkdownStyle, type MarkdownSpan } from "./spans";
import { terminalCellWidth, terminalSegmentsWidth } from "../text/terminal-cells";
import { wrapStyledSpans } from "../text/wrap";

/** Cells between columns. A table is scanned, so its chrome is whitespace. */
const COLUMN_GAP = 2;

/**
 * A column is never squeezed below its longest word while another column can
 * give, so "Friday" does not break into "Frid / ay". A word longer than this
 * does not get to hold the whole table hostage for its own width.
 */
const TABLE_WORD_FLOOR_CAP = 16;

export type TableLine =
  | { readonly kind: "cells"; readonly spans: readonly MarkdownSpan[]; readonly row: number }
  | { readonly kind: "rule" }
  | { readonly kind: "gap"; readonly row: number };

export interface TableLayout {
  readonly lines: readonly TableLine[];
  /** Cells the table actually spans, which the header rule is drawn to. */
  readonly width: number;
}

/**
 * Gaps first, then columns: a table wider than the space must still keep every
 * column. Columns shrink from the widest one still above its longest word, and
 * only when every column is down to its words does a word have to break.
 */
function columnSizes(
  natural: readonly number[],
  width: number,
  longestWord: readonly number[],
): { readonly sizes: readonly number[]; readonly gap: number } {
  const columns = natural.length;
  if (columns === 0) {
    return { sizes: [], gap: 0 };
  }

  let gap = columns > 1 ? COLUMN_GAP : 0;
  let available = width - gap * Math.max(0, columns - 1);
  while (gap > 0 && available < columns) {
    gap -= 1;
    available = width - gap * (columns - 1);
  }
  available = Math.max(columns, available);

  const total = natural.reduce((sum, size) => sum + size, 0);
  const floor = available < columns * 3 ? 1 : 3;
  const wordFloor = natural.map((size, index) =>
    Math.min(size, TABLE_WORD_FLOOR_CAP, longestWord[index] ?? 1),
  );
  const sizes = natural.map((size, index) => {
    if (total <= available) {
      return Math.max(size, 1);
    }
    return Math.max(floor, wordFloor[index] ?? 1, Math.floor((size / total) * available));
  });

  const widestAbove = (limit: (index: number) => number): number => {
    let widest = -1;
    for (let index = 0; index < sizes.length; index += 1) {
      if ((sizes[index] ?? 0) <= limit(index)) {
        continue;
      }
      if (widest < 0 || (sizes[index] ?? 0) > (sizes[widest] ?? 0)) {
        widest = index;
      }
    }
    return widest;
  };
  let used = sizes.reduce((sum, size) => sum + size, 0);
  while (used > available) {
    let widest = widestAbove((index) => wordFloor[index] ?? 1);
    if (widest < 0) {
      widest = widestAbove(() => 1);
    }
    if (widest < 0) {
      break;
    }
    sizes[widest] = (sizes[widest] ?? 1) - 1;
    used -= 1;
  }

  let leftover = available - used;
  while (leftover > 0) {
    let grown = false;
    for (let index = 0; index < sizes.length; index += 1) {
      if (leftover === 0) {
        break;
      }
      if ((sizes[index] ?? 0) < (natural[index] ?? 0)) {
        sizes[index] = (sizes[index] ?? 0) + 1;
        leftover -= 1;
        grown = true;
      }
    }
    if (!grown) {
      break;
    }
  }

  return { sizes, gap };
}

function space(size: number): MarkdownSpan[] {
  return size > 0 ? [{ text: " ".repeat(size), role: "text" }] : [];
}

function alignedCell(
  line: readonly MarkdownSpan[] | undefined,
  size: number,
  align: TableAlign,
): MarkdownSpan[] {
  const content = line ?? [];
  const pad = Math.max(0, size - terminalSegmentsWidth(content));
  if (align === "right") {
    return [...space(pad), ...content];
  }
  if (align === "center") {
    const before = Math.floor(pad / 2);
    return [...space(before), ...content, ...space(pad - before)];
  }
  return [...content, ...space(pad)];
}

/**
 * Borderless columns with a single rule under the header. Cells carry the same
 * inline markdown as prose and wrap inside their column. Body rows sit tight
 * unless one of them wraps, at which point a gap between records is what keeps
 * a two-line cell from reading as two rows.
 */
export function layoutTable(
  rows: readonly (readonly (readonly MarkdownSpan[])[])[],
  align: readonly TableAlign[],
  width: number,
): TableLayout {
  const columns = Math.max(...rows.map((row) => row.length), 1);
  const cells = rows.map((row) =>
    Array.from({ length: columns }, (_, column) => row[column] ?? []),
  );
  const natural = Array.from({ length: columns }, (_, column) =>
    Math.max(...cells.map((row) => terminalSegmentsWidth(row[column] ?? [])), 1),
  );
  const longestWord = Array.from({ length: columns }, (_, column) =>
    Math.max(
      ...cells.map((row) =>
        Math.max(
          0,
          ...(row[column] ?? [])
            .flatMap((span) => span.text.split(/\s+/))
            .map((word) => terminalCellWidth(word)),
        ),
      ),
      1,
    ),
  );
  const { sizes, gap } = columnSizes(natural, width, longestWord);

  const wrappedRows = cells.map((row) =>
    row.map((cell, column) => wrapStyledSpans(cell, sizes[column] ?? 1, sameMarkdownStyle)),
  );
  const heights = wrappedRows.map((row) => Math.max(...row.map((cell) => cell.length), 1));
  const spaced = heights.slice(1).some((height) => height > 1);
  const tableWidth = Math.min(
    width,
    sizes.reduce((sum, size) => sum + size, 0) + gap * Math.max(0, columns - 1),
  );

  const lines: TableLine[] = [];
  wrappedRows.forEach((wrapped, rowIndex) => {
    for (let lineIndex = 0; lineIndex < (heights[rowIndex] ?? 1); lineIndex += 1) {
      const spans: MarkdownSpan[] = [];
      wrapped.forEach((cell, column) => {
        spans.push(...alignedCell(cell[lineIndex], sizes[column] ?? 1, align[column] ?? "left"));
        if (column < columns - 1) {
          spans.push(...space(gap));
        }
      });
      lines.push({ kind: "cells", spans, row: rowIndex });
    }
    if (rowIndex === 0 && wrappedRows.length > 1) {
      lines.push({ kind: "rule" });
    } else if (spaced && rowIndex < wrappedRows.length - 1) {
      lines.push({ kind: "gap", row: rowIndex });
    }
  });
  return { lines, width: tableWidth };
}
