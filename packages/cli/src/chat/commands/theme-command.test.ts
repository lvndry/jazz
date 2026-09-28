import { describe, expect, it } from "bun:test";
import type { ThemeListing } from "@/cli/ui/theme";
import { stripAnsiCodes } from "@/cli/utils/string-utils";
import { themeListingRows } from "./handler";

const listing = (overrides: Partial<ThemeListing>): ThemeListing => ({
  id: "jazz:dark",
  name: "jazz",
  label: "Jazz",
  variant: "dark",
  source: "builtin",
  current: false,
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
    ]).map((row) => stripAnsiCodes(row).trim());

    expect(rows).toHaveLength(3);
    expect(rows[0]).toBe("system        System · your terminal's own colours");
    expect(rows[1]).toContain("jazz");
    expect(rows[1]).toContain("Jazz · dark, light · showing light");
    expect(rows[2]).toBe("paper-ink     Paper Ink · light · /home/me/.jazz/themes/paper-ink.json");
  });
});
