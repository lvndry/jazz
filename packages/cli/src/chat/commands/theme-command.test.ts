import { report } from "@jazz/core/interfaces/terminal";
import { describe, expect, it } from "bun:test";
import { getGlyphs } from "@/cli/ui/glyphs";
import { reportPlainText } from "@/cli/ui/report-layout";
import type { ThemeListing } from "@/cli/ui/theme";
import { themeListingRows } from "./handler";

const listing = (overrides: Partial<ThemeListing>): ThemeListing => ({
  id: "jazz:dark",
  name: "jazz",
  label: "Jazz",
  variant: "dark",
  source: "builtin",
  current: false,
  swatches: [],
  ...overrides,
});

describe("/theme listing", () => {
  it("shows one row per theme with its variants, marking the one on screen", () => {
    const rows = themeListingRows([
      listing({ id: "system:dark", name: "system", label: "System", source: "system" }),
      listing({ id: "jazz:dark" }),
      listing({ id: "jazz:light", variant: "light", current: true }),
      listing({
        id: "paper-ink:light",
        name: "paper-ink",
        label: "Paper Ink",
        variant: "light",
        source: "/home/me/.jazz/themes/paper-ink.json",
      }),
    ]);
    const { arrow } = getGlyphs();
    expect(reportPlainText(report("theme", rows), getGlyphs()).split("\n")).toEqual([
      "theme       system      System · your terminal's own colours",
      `          ${arrow} jazz        Jazz · dark, light · showing light`,
      "            paper-ink   Paper Ink · light · /home/me/.jazz/themes/paper-ink.json",
    ]);
  });
});
