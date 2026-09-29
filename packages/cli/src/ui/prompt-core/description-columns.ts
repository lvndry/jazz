/**
 * Descriptions that use tabs as column breaks, set so each column lines up across a list's
 * choices. Shared by both renderers' pickers, so a model list reads as a table in either.
 */

import { terminalCellWidth } from "../text/terminal-cells";

/** Pads a column; a no-break space survives word wrapping and whitespace collapsing. */
export const COLUMN_PAD = " ";

/** Cells kept between two tab-separated columns. */
export const COLUMN_GAP = 2;

/**
 * Replace each tab with the padding that lines its column up across `descriptions`. An entry
 * without a tab, or undefined, is returned as it came.
 */
export function alignTabColumns(
  descriptions: readonly (string | undefined)[],
): (string | undefined)[] {
  if (!descriptions.some((description) => description?.includes("\t") === true)) {
    return [...descriptions];
  }
  const split = descriptions.map((description) => description?.split("\t"));
  const widths: number[] = [];
  for (const cells of split) {
    cells?.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, terminalCellWidth(cell));
    });
  }
  return split.map((cells) =>
    cells === undefined
      ? undefined
      : cells
          .map((cell, index) =>
            index === cells.length - 1
              ? cell
              : cell +
                COLUMN_PAD.repeat((widths[index] ?? 0) - terminalCellWidth(cell) + COLUMN_GAP),
          )
          .join(""),
  );
}
