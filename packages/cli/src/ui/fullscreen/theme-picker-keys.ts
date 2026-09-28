import type { ThemePickerRow } from "./types";

/**
 * Where a key moves the theme picker's highlight, or null when the key does not move it.
 * Up and down step through the rows without wrapping; `l` jumps to the same theme's other
 * variant, when it has one.
 */
export function themePickerTarget(
  rows: readonly ThemePickerRow[],
  current: number,
  key: { readonly name: string; readonly sequence: string },
): number | null {
  if (rows.length === 0) return null;
  if (key.name === "up") return Math.max(0, current - 1);
  if (key.name === "down") return Math.min(rows.length - 1, current + 1);
  if (key.sequence === "l" || key.sequence === "L") {
    const row = rows[current];
    if (row === undefined) return null;
    const other = rows.findIndex(
      (candidate) => candidate.name === row.name && candidate.variant !== row.variant,
    );
    return other < 0 ? null : other;
  }
  return null;
}
