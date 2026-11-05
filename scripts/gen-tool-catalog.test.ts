import { readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";
import {
  REGENERATE_COMMAND,
  TOOL_CATALOG_DOC,
  renderToolCatalog,
  toolCatalogRows,
} from "./gen-tool-catalog";

describe("tool catalog", () => {
  it("lists the tools the agent runner registers per run, marked as such", async () => {
    const rows = await toolCatalogRows();
    const perRun = new Map(rows.map((row) => [row.name, row.registration]));
    expect(perRun.get("browser_adopt_tab")).toBe("per run");
    expect(perRun.get("ask_peer")).toContain("peer");
    expect(perRun.get("find_skills")).toContain("skills");
    expect(perRun.get("read_file")).toBe("startup");
  });

  it("shows the summary a model sees: the runtime's truncation of a long first description line", async () => {
    const rows = await toolCatalogRows();
    const row = rows.find((candidate) => candidate.name === "list_triggers");
    expect(row?.description.endsWith("...")).toBe(true);
    expect(row?.description.length).toBeLessThanOrEqual(103);
  });

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
