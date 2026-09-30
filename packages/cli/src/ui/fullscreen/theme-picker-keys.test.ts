import { describe, expect, it } from "bun:test";
import { themePickerTarget, themePickerVisibleRows } from "./theme-picker-keys";
import type { ThemePickerRow } from "./types";

function row(name: string, variant: "dark" | "light"): ThemePickerRow {
  return { id: `${name}:${variant}`, name, label: name, variant, swatches: [], current: false };
}

const rows = [
  row("catppuccin", "dark"),
  row("catppuccin", "light"),
  row("jazz", "dark"),
  row("jazz", "light"),
  row("midnight", "dark"),
];

const press = (name: string) => ({ name, sequence: "" });

describe("themePickerTarget", () => {
  it("steps up and down within the current variant only", () => {
    expect(themePickerTarget(rows, 0, press("down"))).toBe(2);
    expect(themePickerTarget(rows, 2, press("down"))).toBe(4);
    expect(themePickerTarget(rows, 4, press("down"))).toBe(4);
    expect(themePickerTarget(rows, 3, press("up"))).toBe(1);
    expect(themePickerTarget(rows, 1, press("up"))).toBe(1);
  });

  it("switches variant on the same theme with left and right", () => {
    expect(themePickerTarget(rows, 2, press("right"))).toBe(3);
    expect(themePickerTarget(rows, 3, press("left"))).toBe(2);
  });

  it("lands on the first theme of the other list when the theme lacks that variant", () => {
    expect(themePickerTarget(rows, 4, press("right"))).toBe(1);
  });

  it("stays put when already on the requested variant", () => {
    expect(themePickerTarget(rows, 0, press("left"))).toBeNull();
    expect(themePickerTarget(rows, 1, press("right"))).toBeNull();
  });
});

describe("themePickerVisibleRows", () => {
  it("lists only the highlighted row's variant", () => {
    expect(themePickerVisibleRows(rows, 1).map((entry) => entry.id)).toEqual([
      "catppuccin:light",
      "jazz:light",
    ]);
  });
});
