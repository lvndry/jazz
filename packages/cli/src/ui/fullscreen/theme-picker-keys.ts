import type { ThemePickerRow } from "./types";

/** The rows the picker lists: those sharing the highlighted row's variant, in list order. */
export function themePickerVisibleRows(
  rows: readonly ThemePickerRow[],
  selected: number,
): readonly ThemePickerRow[] {
  const highlighted = rows[selected];
  if (highlighted === undefined) {
    return rows;
  }
  return rows.filter((row) => row.variant === highlighted.variant);
}

/**
 * Where a key moves the theme picker's highlight, or null when the key does not move it.
 * Up and down step through the themes of the current variant without wrapping; left and
 * right switch between the dark and light lists, landing on the same theme when it has the
 * other variant and on the first theme of that list when it does not.
 */
export function themePickerTarget(
  rows: readonly ThemePickerRow[],
  current: number,
  key: { readonly name: string; readonly sequence: string },
): number | null {
  const row = rows[current];
  if (row === undefined) {
    return null;
  }
  if (key.name === "up" || key.name === "down") {
    const step = key.name === "up" ? -1 : 1;
    for (let index = current + step; index >= 0 && index < rows.length; index += step) {
      if (rows[index]?.variant === row.variant) {
        return index;
      }
    }
    return current;
  }
  if (key.name === "left" || key.name === "right") {
    const wanted = key.name === "left" ? "dark" : "light";
    if (row.variant === wanted) {
      return null;
    }
    const sameTheme = rows.findIndex(
      (candidate) => candidate.name === row.name && candidate.variant === wanted,
    );
    const target =
      sameTheme >= 0 ? sameTheme : rows.findIndex((candidate) => candidate.variant === wanted);
    return target < 0 ? null : target;
  }
  return null;
}
