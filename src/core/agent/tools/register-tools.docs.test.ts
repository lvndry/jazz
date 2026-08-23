/**
 * Guards `docs/reference/tools.md` against drift from the tool registry.
 *
 * The page previously listed eight tools that did not exist (`search_web`, `run_command`,
 * `list_dir`, …) and omitted more than half of the real ones, because it was maintained by
 * hand. This test makes the registry the single source of truth: add or rename a tool and
 * the docs fail until they are updated.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { ToolRegistryTag, type ToolRiskLevel } from "@/core/interfaces/tool-registry";
import { registerAllTools } from "./register-tools";
import { createToolRegistryLayer } from "./tool-registry";

/** Repo-relative; `bun test` runs from the repository root. */
const DOCS_PATH = "docs/reference/tools.md";

interface RegisteredTool {
  readonly name: string;
  readonly riskLevel: ToolRiskLevel;
}

/**
 * Registers every globally-registered tool category and returns the agent-facing tools.
 *
 * Skills and MCP tools are excluded because they are registered per agent, not globally,
 * and the docs describe them separately.
 */
const collectTools = Effect.gen(function* () {
  yield* registerAllTools();

  const registry = yield* ToolRegistryTag;
  const names = yield* registry.listTools();
  const tools: RegisteredTool[] = [];
  for (const name of names) {
    const tool = yield* registry.getTool(name);
    tools.push({ name: tool.name, riskLevel: tool.riskLevel });
  }
  return tools;
});

async function registeredTools(): Promise<readonly RegisteredTool[]> {
  return Effect.runPromise(collectTools.pipe(Effect.provide(createToolRegistryLayer())));
}

/** Rows look like: `| \`read_file\` | \`read-only\` | — | description |` */
function documentedTools(markdown: string): Map<string, string> {
  const documented = new Map<string, string>();
  const rowPattern = /^\|\s*`([a-z_0-9]+)`\s*\|\s*`(read-only|low-risk|high-risk|unknown)`\s*\|/gm;
  for (const match of markdown.matchAll(rowPattern)) {
    const [, name, risk] = match;
    if (name !== undefined && risk !== undefined) documented.set(name, risk);
  }
  return documented;
}

describe("docs/reference/tools.md", () => {
  it("documents exactly the registered agent-facing tools", async () => {
    const tools = await registeredTools();
    const documented = documentedTools(readFileSync(DOCS_PATH, "utf-8"));

    const registeredNames = tools.map((tool) => tool.name).sort();
    const documentedNames = [...documented.keys()].sort();

    const missing = registeredNames.filter((name) => !documented.has(name));
    const extra = documentedNames.filter(
      (name) => !registeredNames.includes(name) && !name.startsWith("execute_"),
    );

    expect(missing, `${DOCS_PATH} is missing tools: ${missing.join(", ")}`).toEqual([]);
    expect(extra, `${DOCS_PATH} documents unknown tools: ${extra.join(", ")}`).toEqual([]);
  });

  it("records the correct risk level for every tool", async () => {
    const tools = await registeredTools();
    const documented = documentedTools(readFileSync(DOCS_PATH, "utf-8"));

    const mismatches = tools
      .filter((tool) => documented.has(tool.name) && documented.get(tool.name) !== tool.riskLevel)
      .map(
        (tool) =>
          `${tool.name}: docs say ${documented.get(tool.name)}, registry says ${tool.riskLevel}`,
      );

    expect(mismatches, mismatches.join("; ")).toEqual([]);
  });

  it("reports the agent-facing tool count accurately", async () => {
    const tools = await registeredTools();
    // Prettier pads markdown table cells to align the column, so the row is
    // compared with its runs of spaces collapsed. Matching the unpadded row
    // literally could never succeed once the file had been formatted, which
    // made this read as a stale count when the count was in fact correct.
    const markdown = readFileSync(DOCS_PATH, "utf-8").replace(/[ \t]+/g, " ");

    expect(markdown, `${DOCS_PATH} should state the real tool count (${tools.length})`).toContain(
      `| **Agent-facing tools** | **${tools.length}** |`,
    );
  });
});
