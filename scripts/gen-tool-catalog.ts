/**
 * Generates `docs/maintainers/tool-catalog.md`: one row per built-in tool, read from the same
 * registration code the harness runs (`registerAllTools` at startup, then the per-run registrars
 * the agent runner calls: browser tab adoption, skill tools and peer tools), so the page cannot disagree with what a
 * model is offered.
 *
 * Each row carries the tool's group (its registered category), whether the group is `eager`
 * (schema sent with every request) or `deferred` (a one-line summary every turn, schema on
 * demand), its risk level, its parameter names, and an estimate of its token cost. The
 * description column is the `summary` the deferred-tool list shows, which is the tool's own
 * `summary` or the truncated first line of its `description`; nothing is written by hand.
 *
 * Token cost is an estimate: characters of name, description and parameter JSON Schema divided by
 * 4, rounded up. "Schema" is the cost of the full definition; "Always on" is what a request pays
 * for the tool whenever the run holds it, which is the full definition for an `eager` group and
 * the name plus summary for a `deferred` one. Hidden `execute_*` halves are never sent to a model
 * and cost 0.
 *
 * Output is sorted and contains no timestamps, so a diff in review is a real change. Run
 * `bun run docs:tool-catalog` after adding, renaming or rewording a tool, or changing a parameter;
 * `bun run docs:tool-catalog:check` fails when the checked-in page differs. It needs no network
 * and no credentials: registration builds tool objects and runs nothing.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  registerAllTools,
  registerBrowserAdoptionTools,
  registerPeerTools,
  registerSkillSystemTools,
} from "@jazz/core/agent/tools/register-tools";
import { createToolRegistryLayer, truncateForSummary } from "@jazz/core/agent/tools/tool-registry";
import { AgentConfigServiceTag, type AgentConfigService } from "@jazz/core/interfaces/agent-config";
import {
  ToolRegistryTag,
  type Tool,
  type ToolRegistry,
  type ToolRequirements,
} from "@jazz/core/interfaces/tool-registry";
import type { ToolCategory } from "@jazz/core/types/tools";
import { Effect, Layer } from "effect";
import { z } from "zod";

export const TOOL_CATALOG_DOC = path.join(
  import.meta.dir,
  "..",
  "docs",
  "maintainers",
  "tool-catalog.md",
);

export const REGENERATE_COMMAND = "bun run docs:tool-catalog";

const CHARACTERS_PER_TOKEN = 4;
const UNGROUPED = "Other";

const ALWAYS_REGISTERED = "startup";

interface RegisteredTool {
  readonly tool: Tool<ToolRequirements>;
  readonly category: ToolCategory | undefined;
  readonly registration: string;
}

/**
 * Peer tools are registered only for a configured peer, so the generator supplies one. Only its
 * name and address reach the peer tool's own text.
 */
const placeholderPeerConfig = {
  appConfig: Effect.succeed({ peers: [{ name: "peer", url: "https://peer.example" }] }),
} as unknown as AgentConfigService;

type JsonSchemaObject = {
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
};

export interface ToolCatalogRow {
  readonly name: string;
  readonly group: string;
  readonly tier: "eager" | "deferred";
  readonly internal: boolean;
  readonly hidden: boolean;
  readonly registration: string;
  readonly riskLevel: string;
  readonly parameters: readonly string[];
  readonly description: string;
  readonly schemaTokens: number;
  readonly alwaysOnTokens: number;
}

function estimateTokens(characters: number): number {
  return Math.ceil(characters / CHARACTERS_PER_TOKEN);
}

function parameterSchema(tool: Tool<ToolRequirements>): JsonSchemaObject {
  return (tool.jsonSchema as JsonSchemaObject | undefined) ?? z.toJSONSchema(tool.parameters);
}

function parameterNames(schema: JsonSchemaObject): readonly string[] {
  const required = new Set(schema.required ?? []);
  return Object.keys(schema.properties ?? {})
    .sort(compareText)
    .map((name) => (required.has(name) ? `${name}*` : name));
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

/**
 * Registers every global built-in tool through a registry that records each tool's category, so
 * hidden and internal tools keep theirs, and returns the registered tools with that category.
 */
async function registeredTools(): Promise<readonly RegisteredTool[]> {
  const recorded = new Map<string, RegisteredTool>();
  let registration = ALWAYS_REGISTERED;
  const registry = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* ToolRegistryTag;
    }).pipe(Effect.provide(createToolRegistryLayer())),
  );
  const recording: ToolRegistry = new Proxy(registry, {
    get(target, property) {
      if (property === "registerTool") {
        return (tool: Tool<ToolRequirements>, category?: ToolCategory) => {
          recorded.set(tool.name, { tool, category, registration });
          return target.registerTool(tool, category);
        };
      }
      if (property === "registerForCategory") {
        return (category: ToolCategory) => (tool: Tool<ToolRequirements>) =>
          recording.registerTool(tool, category);
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function"
        ? (value as (...args: readonly unknown[]) => unknown).bind(target)
        : value;
    },
  });
  const registryLayer = Layer.succeed(ToolRegistryTag, recording);
  const peerConfigLayer = Layer.succeed(ToolRegistryTag, recording).pipe(
    Layer.merge(Layer.succeed(AgentConfigServiceTag, placeholderPeerConfig)),
  );
  await Effect.runPromise(registerAllTools().pipe(Effect.provide(registryLayer)));
  registration = "per run";
  await Effect.runPromise(registerBrowserAdoptionTools().pipe(Effect.provide(registryLayer)));
  registration = "per run, when the agent has skills";
  await Effect.runPromise(registerSkillSystemTools([]).pipe(Effect.provide(registryLayer)));
  registration = "per run, when a peer is configured";
  await Effect.runPromise(registerPeerTools().pipe(Effect.provide(peerConfigLayer)));
  return [...recorded.values()];
}

export async function toolCatalogRows(): Promise<readonly ToolCatalogRow[]> {
  const registered = await registeredTools();
  const approvalOwnerByExecuteName = new Map<string, Tool<ToolRequirements>>();
  for (const { tool } of registered) {
    if (tool.approvalExecuteToolName !== undefined) {
      approvalOwnerByExecuteName.set(tool.approvalExecuteToolName, tool);
    }
  }
  const categoryByName = new Map(registered.map(({ tool, category }) => [tool.name, category]));

  const rows = registered.map(({ tool, category, registration }): ToolCatalogRow => {
    const owner = approvalOwnerByExecuteName.get(tool.name);
    const effectiveCategory = category ?? (owner ? categoryByName.get(owner.name) : undefined);
    const tier = effectiveCategory?.loadTier ?? "eager";
    const schema = parameterSchema(tool);
    const fullCharacters =
      tool.name.length + tool.description.length + JSON.stringify(schema).length;
    const summary = tool.summary ?? truncateForSummary(tool.description);
    const summaryCharacters = tool.name.length + summary.length;
    return {
      name: tool.name,
      group: effectiveCategory?.displayName ?? UNGROUPED,
      tier,
      internal: effectiveCategory?.internal === true,
      hidden: tool.hidden,
      registration,
      riskLevel: tool.riskLevel,
      parameters: parameterNames(schema),
      description: tool.hidden ? `Runs the action \`${owner?.name ?? "?"}\` proposed.` : summary,
      schemaTokens: tool.hidden ? 0 : estimateTokens(fullCharacters),
      alwaysOnTokens: tool.hidden
        ? 0
        : estimateTokens(tier === "eager" ? fullCharacters : summaryCharacters),
    };
  });

  return rows.sort(
    (left, right) => compareText(left.group, right.group) || compareText(left.name, right.name),
  );
}

function escapeCell(text: string): string {
  return text.replaceAll("|", "\\|");
}

function toolsTable(rows: readonly ToolCatalogRow[]): string {
  const lines = [
    "| Tool | Group | Tier | Registered | Risk | Parameters | Schema tokens | Always-on tokens | Summary |",
    "| --- | --- | --- | --- | --- | --- | ---: | ---: | --- |",
  ];
  for (const row of rows) {
    const parameters = row.parameters.map((name) => `\`${name}\``).join(", ");
    const markers = [row.hidden ? "hidden" : "", row.internal ? "internal" : ""]
      .filter((marker) => marker !== "")
      .join(", ");
    const group = markers === "" ? row.group : `${row.group} (${markers})`;
    lines.push(
      `| \`${row.name}\` | ${escapeCell(group)} | ${row.tier} | ${row.registration} | \`${row.riskLevel}\` | ${parameters} | ${row.schemaTokens} | ${row.alwaysOnTokens} | ${escapeCell(row.description)} |`,
    );
  }
  return lines.join("\n");
}

function groupsTable(rows: readonly ToolCatalogRow[]): string {
  const groups = new Map<string, { tier: string; tools: number; alwaysOn: number }>();
  for (const row of rows) {
    const entry = groups.get(row.group) ?? { tier: row.tier, tools: 0, alwaysOn: 0 };
    entry.tools += 1;
    entry.alwaysOn += row.alwaysOnTokens;
    groups.set(row.group, entry);
  }
  const lines = ["| Group | Tier | Tools | Always-on tokens |", "| --- | --- | ---: | ---: |"];
  for (const [group, entry] of [...groups].sort(([left], [right]) => compareText(left, right))) {
    lines.push(`| ${escapeCell(group)} | ${entry.tier} | ${entry.tools} | ${entry.alwaysOn} |`);
  }
  return lines.join("\n");
}

/**
 * The whole page. Tables are unpadded and the file is listed in `.prettierignore`, so changing one
 * tool changes only its own row and concurrent pull requests do not conflict.
 */
export async function renderToolCatalog(): Promise<string> {
  const rows = await toolCatalogRows();
  const page = `---
description: "Generated catalog of every built-in Jazz tool with its group, load tier, risk level, parameters and an estimated token cost, checked against the registry in CI."
---

# Built-in tool catalog

Generated from the tool registry by \`scripts/gen-tool-catalog.ts\`. Do not edit by hand: run
\`${REGENERATE_COMMAND}\` after adding, renaming or rewording a tool or changing a parameter, and
commit the result. \`bun run docs:tool-catalog:check\` fails when this page is stale.

Token counts are estimates: characters divided by 4, rounded up. They are for comparing tools in
review, not for billing. **Schema tokens** is the full definition (name, description and
parameter JSON Schema). **Always-on tokens** is what each request pays for the tool whenever a run
holds it: the full definition in an \`eager\` group, the name and one-line summary in a
\`deferred\` one. A parameter ending in \`*\` is required. A hidden \`execute_*\` tool is the second
half of an approval pair and is never sent to a model. For what each risk level allows, see
[tool inventory](../tools/index.md) and [tool lifecycle](./tool-lifecycle.md).

**Registered** is when the tool exists: \`startup\` for every run, \`per run\` for a tool the
agent runner registers at the start of each run, and \`per run, when ...\` for one that exists only
under that condition. The generator calls the same registration functions the runner calls and
supplies a placeholder peer so the peer tools appear.

Not listed: MCP server tools, plugin tools and \`customTools\` from agent configs, which come from
configuration; and the skill tools' skill-name constraint, which depends on the skills installed.

## Groups

${groupsTable(rows)}

## Tools

${toolsTable(rows)}
`;
  return page;
}

// eslint-disable-next-line n/no-unsupported-features/node-builtins -- Bun script entry point.
if (import.meta.main) {
  const generated = await renderToolCatalog();
  const relativePath = path.relative(process.cwd(), TOOL_CATALOG_DOC);
  if (process.argv.includes("--check")) {
    let current: string;
    try {
      current = readFileSync(TOOL_CATALOG_DOC, "utf-8");
    } catch {
      current = "";
    }
    if (current !== generated) {
      console.error(
        `${relativePath} is out of date with the tool registry.\nRegenerate it with \`${REGENERATE_COMMAND}\` and commit the result.`,
      );
      process.exit(1);
    }
    console.log(`✓ ${relativePath} matches the tool registry`);
  } else {
    writeFileSync(TOOL_CATALOG_DOC, generated);
    console.log(`✓ regenerated ${relativePath}`);
  }
}
