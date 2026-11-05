import { readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";
import {
  REGENERATE_COMMAND,
  TOOL_CATALOG_DOC,
  renderToolCatalog,
  toolCatalogRows,
} from "./gen-tool-catalog";

describe("tool catalog", () => {
  it("places every tool in a registered group", async () => {
    const rows = await toolCatalogRows();
    expect(rows.filter((row) => row.group === "Other").map((row) => row.name)).toEqual([]);
  });

  it("charges nothing for a hidden tool and never more always-on than schema tokens", async () => {
    const rows = await toolCatalogRows();
    for (const row of rows) {
      expect(row.alwaysOnTokens).toBeLessThanOrEqual(row.schemaTokens);
      if (row.hidden) {
        expect(row.schemaTokens).toBe(0);
      }
    }
  });

  it("generates the same page twice", async () => {
    expect(await renderToolCatalog()).toBe(await renderToolCatalog());
  });

  it(`matches the published page (run \`${REGENERATE_COMMAND}\`)`, async () => {
    expect(await renderToolCatalog()).toBe(readFileSync(TOOL_CATALOG_DOC, "utf-8"));
  });
});
