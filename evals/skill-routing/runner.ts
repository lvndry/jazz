/** Runs the frozen routing corpus through Jazz's raw-request lexical scorer. */
import { scoreSkillsForQuery, type SkillMetadata } from "@/core/skills/skill-service";
import { SKILL_ROUTING_DATASET_VERSION, skillRoutingCases } from "./dataset";
import type {
  RoutingMetricBlock,
  RoutingScenario,
  SkillRoutingCase,
  SkillRoutingReport,
} from "./schema";

function isHit(expected: SkillRoutingCase["expected"], selected: readonly string[]): boolean {
  if (expected.kind === "no-skill") return selected.length === 0;
  const accepted = expected.kind === "skill" ? [expected.skillName] : expected.skillNames;
  return selected.some((name) => accepted.includes(name));
}

function metricBlock(
  rows: readonly { readonly input: SkillRoutingCase; readonly selected: readonly string[] }[],
): RoutingMetricBlock {
  const noSkill = rows.filter((row) => row.input.expected.kind === "no-skill");
  const anyOf = rows.filter((row) => row.input.expected.kind === "any-of");
  const ratio = (matches: number) => (rows.length === 0 ? 0 : matches / rows.length);
  return {
    cases: rows.length,
    coverage: ratio(rows.filter((row) => row.selected.length > 0).length),
    top1Recall: ratio(
      rows.filter((row) => isHit(row.input.expected, row.selected.slice(0, 1))).length,
    ),
    top3Recall: ratio(
      rows.filter((row) => isHit(row.input.expected, row.selected.slice(0, 3))).length,
    ),
    noSkillFalsePositiveRate:
      noSkill.length === 0
        ? null
        : noSkill.filter((row) => row.selected.length > 0).length / noSkill.length,
    setHitRate:
      anyOf.length === 0
        ? null
        : anyOf.filter((row) => isHit(row.input.expected, row.selected)).length / anyOf.length,
    brierScore: null,
  };
}

export function runLexicalRoutingBenchmark(
  split: "dev" | "test" | "all" = "all",
): SkillRoutingReport {
  const inputs = skillRoutingCases.filter((entry) => split === "all" || entry.split === split);
  const rows = inputs.map((input) => {
    const skills: readonly SkillMetadata[] = input.roster.map((skill) => ({
      ...skill,
      path: `/fixture/${skill.name}/SKILL.md`,
      source: "local",
    }));
    return {
      input,
      selected: scoreSkillsForQuery(input.requestText, skills, 3).map((skill) => skill.name),
    };
  });
  const scenarios: readonly RoutingScenario[] = [
    "exact-name",
    "synonym",
    "ambiguous",
    "multi-skill",
    "no-skill",
  ];
  return {
    schemaVersion: 1,
    benchmark: "raw-request-lexical-proxy",
    datasetVersion: SKILL_ROUTING_DATASET_VERSION,
    split,
    overall: metricBlock(rows),
    byScenario: Object.fromEntries(
      scenarios.map((scenario) => [
        scenario,
        metricBlock(rows.filter((row) => row.input.scenario === scenario)),
      ]),
    ) as Record<RoutingScenario, RoutingMetricBlock>,
    cases: rows.map((row) => ({
      id: row.input.id,
      scenario: row.input.scenario,
      selected: row.selected,
      hitAt1: isHit(row.input.expected, row.selected.slice(0, 1)),
      hitAt3: isHit(row.input.expected, row.selected.slice(0, 3)),
    })),
  };
}

// eslint-disable-next-line n/no-unsupported-features/node-builtins -- Bun evaluation entry point.
if (import.meta.main) {
  const requested = process.argv[2];
  const split = requested === "dev" || requested === "test" ? requested : "all";
  process.stdout.write(`${JSON.stringify(runLexicalRoutingBenchmark(split), null, 2)}\n`);
}
