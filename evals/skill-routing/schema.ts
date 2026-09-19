/**
 * Frozen component-benchmark schema for skill routing.
 *
 * This benchmark deliberately separates the raw-request lexical proxy from Jazz's
 * end-to-end behaviour, where the conversation model sees the skill index and authors
 * any `find_skills` query itself.
 */

export type RoutingScenario = "exact-name" | "synonym" | "ambiguous" | "multi-skill" | "no-skill";

export interface RoutingSkill {
  readonly name: string;
  readonly description: string;
}

export type RoutingExpectation =
  | { readonly kind: "skill"; readonly skillName: string }
  | { readonly kind: "no-skill" }
  | { readonly kind: "any-of"; readonly skillNames: readonly string[] };

export interface SkillRoutingCase {
  readonly id: string;
  readonly split: "dev" | "test";
  readonly requestText: string;
  readonly roster: readonly RoutingSkill[];
  readonly expected: RoutingExpectation;
  readonly scenario: RoutingScenario;
  readonly rosterSize: "small" | "large";
  readonly adversarial: boolean;
}

export interface RoutingMetricBlock {
  readonly cases: number;
  readonly coverage: number;
  readonly top1Recall: number;
  readonly top3Recall: number;
  readonly noSkillFalsePositiveRate: number | null;
  readonly setHitRate: number | null;
  readonly brierScore: number | null;
}

export interface SkillRoutingReport {
  readonly schemaVersion: 1;
  readonly benchmark: "raw-request-lexical-proxy";
  readonly datasetVersion: string;
  readonly split: "dev" | "test" | "all";
  readonly overall: RoutingMetricBlock;
  readonly byScenario: Readonly<Record<RoutingScenario, RoutingMetricBlock>>;
  readonly cases: readonly {
    readonly id: string;
    readonly scenario: RoutingScenario;
    readonly selected: readonly string[];
    readonly hitAt1: boolean;
    readonly hitAt3: boolean;
  }[];
}
