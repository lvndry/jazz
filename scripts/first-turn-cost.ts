/**
 * `bun run bench:first-turn`: measures the fixed per-request cost of the default agent and
 * fails when it exceeds the ceiling derived from `bench/budgets.json`. Offline and
 * deterministic apart from the environment block of the prompt: no provider, no network, no
 * user configuration (an empty JAZZ_HOME).
 *
 * "Default agent" means: persona `default`, every selectable tool category granted, no
 * skills, no MCP servers, no AGENTS.md, no stored preferences, in an attended chat run.
 * Tools are partitioned by load tier exactly as a run does, and each eager schema is
 * serialized through the adapter's own `buildToolInputSchema`, the shape a provider receives.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { z } from "zod";
import {
  firstTurnFailures,
  firstTurnLoweringHints,
  formatFirstTurnReport,
  type FirstTurnMeasurement,
} from "./first-turn-budget";

const jazzHome = mkdtempSync(join(tmpdir(), "jazz-first-turn-"));
process.env["JAZZ_HOME"] = jazzHome;
process.on("exit", () => {
  rmSync(jazzHome, { recursive: true, force: true });
});

const { buildToolInputSchema } = await import("../packages/adapters/src/llm/ai-sdk-service");
const { PersonaServiceImpl } = await import("../packages/adapters/src/persona-service");
const { agentPromptBuilder } = await import("../packages/core/src/agent/agent-prompt");
const { resolveAgentToolNames, runToolDenials } =
  await import("../packages/core/src/agent/tools/agent-tool-resolution");
const { registerAllTools, registerSkillSystemTools, registerBrowserAdoptionTools } =
  await import("../packages/core/src/agent/tools/register-tools");
const { createToolRegistryLayer } = await import("../packages/core/src/agent/tools/tool-registry");
const { ToolRegistryTag } = await import("../packages/core/src/interfaces/tool-registry");
const { countTokens } = await import("gpt-tokenizer/encoding/o200k_base");

const baseline = z
  .object({
    firstTurn: z.object({
      systemPromptTokens: z.number().int().positive(),
      toolSchemaTokens: z.number().int().positive(),
      toolCount: z.number().int().positive(),
    }),
  })
  .parse(
    JSON.parse(readFileSync(new URL("../bench/budgets.json", import.meta.url), "utf8")),
  ).firstTurn;

const grantedToolNames: string[] = [];
const defaultAgent = {
  id: "first-turn-budget",
  name: "jazz",
  description: "",
  config: {
    persona: "default",
    llm: { provider: "openai", model: "gpt-5" },
    tools: grantedToolNames,
  },
};
const attendedChatSurface = { origin: { source: "chat" }, offersGoalProposals: true };

function measure(): Effect.Effect<FirstTurnMeasurement, Error, never> {
  return Effect.gen(function* () {
    yield* registerAllTools();
    yield* registerBrowserAdoptionTools();
    yield* registerSkillSystemTools([]);
    const registry = yield* ToolRegistryTag;

    const categories = yield* registry.listCategories();
    const selectableToolNames = yield* Effect.all(
      categories
        .filter((category) => category.internal !== true)
        .map((category) => registry.getToolsInCategory(category.id)),
    );
    grantedToolNames.push(...selectableToolNames.flat());

    const resolvedNames = yield* resolveAgentToolNames(defaultAgent as never);
    const denied = runToolDenials(defaultAgent as never, undefined, attendedChatSurface as never);
    const offeredNames = resolvedNames.filter((name) => !denied.has(name));
    const { eager, deferred } = yield* registry.partitionByTier(offeredNames);

    const definitions = yield* registry.getToolDefinitionsFor(eager);
    const toolSchemas = definitions.map((definition) => {
      const schema: unknown = buildToolInputSchema(definition).jsonSchema;
      const serialized = JSON.stringify({
        name: definition.function.name,
        description: definition.function.description,
        parameters: schema,
      });
      return { name: definition.function.name, tokens: countTokens(serialized) };
    });

    const systemPrompt = yield* agentPromptBuilder.buildSystemPrompt(
      "default",
      {
        agentName: defaultAgent.name,
        agentDescription: defaultAgent.description,
        userInput: "",
        toolNames: offeredNames,
        availableTools: Object.fromEntries(
          definitions.map((definition) => [
            definition.function.name,
            definition.function.description,
          ]),
        ),
        deferredTools: [...(yield* registry.getToolSummaries(deferred))],
      },
      new PersonaServiceImpl(),
    );

    return { systemPromptTokens: countTokens(systemPrompt), toolSchemas };
  }).pipe(Effect.provide(createToolRegistryLayer()));
}

const measurement = await Effect.runPromise(measure());
console.log(formatFirstTurnReport(measurement, baseline));

for (const hint of firstTurnLoweringHints(measurement, baseline)) {
  console.log(`\nnote: ${hint}`);
}

const failures = firstTurnFailures(measurement, baseline);
if (failures.length > 0) {
  console.error(`\n${String(failures.length)} first-turn budget(s) exceeded:`);
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  console.error(
    "\nEvery request pays this cost before the user's first word. Trim the part named above (the\n" +
      "largest schemas are listed), or make the tool deferred. Raising a baseline in\n" +
      "bench/budgets.json is a deliberate, reviewed product decision. See bench/README.md.",
  );
  process.exit(1);
}
console.log("\nFirst-turn budget passed");
