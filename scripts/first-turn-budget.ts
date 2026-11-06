/**
 * Pure evaluation of the first-turn token budget: the fixed per-request cost of the default
 * agent, system prompt plus the tool schemas it declares eagerly. Figures are estimates from
 * the o200k tokenizer; providers tokenize differently, so only the trend is meaningful.
 *
 * `bench/budgets.json` stores the reviewed baseline (the measured values at the last
 * deliberate change). The enforced ceiling is baseline plus the headroom constants below, so
 * a ceiling can only move through an edit to that file in a reviewed pull request.
 */

/**
 * The prompt embeds the environment block (date, OS, hardware, shell, hostname, username),
 * whose rendered length differs between machines and days by a few dozen tokens.
 */
export const SYSTEM_PROMPT_HEADROOM_TOKENS = 50;

/**
 * Schema text is deterministic for a given checkout; this absorbs only tokenizer or Zod
 * serializer upgrades that reshape equivalent schemas.
 */
export const TOOL_SCHEMA_HEADROOM_TOKENS = 100;

/** A new eager tool is a deliberate decision: no slack. */
export const TOOL_COUNT_HEADROOM = 0;

/** Reviewers see this many of the largest schemas in the breakdown. */
export const BREAKDOWN_TOOL_LIMIT = 10;

export interface ToolSchemaCost {
  readonly name: string;
  readonly tokens: number;
}

export interface FirstTurnMeasurement {
  readonly systemPromptTokens: number;
  readonly toolSchemas: readonly ToolSchemaCost[];
}

export interface FirstTurnBaseline {
  readonly systemPromptTokens: number;
  readonly toolSchemaTokens: number;
  readonly toolCount: number;
}

export interface FirstTurnTotals {
  readonly systemPromptTokens: number;
  readonly toolSchemaTokens: number;
  readonly toolCount: number;
  readonly totalTokens: number;
}

export function firstTurnTotals(measurement: FirstTurnMeasurement): FirstTurnTotals {
  const toolSchemaTokens = measurement.toolSchemas.reduce((sum, tool) => sum + tool.tokens, 0);
  return {
    systemPromptTokens: measurement.systemPromptTokens,
    toolSchemaTokens,
    toolCount: measurement.toolSchemas.length,
    totalTokens: measurement.systemPromptTokens + toolSchemaTokens,
  };
}

export function firstTurnCeilings(baseline: FirstTurnBaseline): FirstTurnBaseline {
  return {
    systemPromptTokens: baseline.systemPromptTokens + SYSTEM_PROMPT_HEADROOM_TOKENS,
    toolSchemaTokens: baseline.toolSchemaTokens + TOOL_SCHEMA_HEADROOM_TOKENS,
    toolCount: baseline.toolCount + TOOL_COUNT_HEADROOM,
  };
}

function percent(excess: number, limit: number): string {
  return limit === 0 ? "n/a" : `+${((excess / limit) * 100).toFixed(1)}%`;
}

interface Dimension {
  readonly label: string;
  readonly unit: string;
  readonly measured: number;
  readonly baseline: number;
  readonly ceiling: number;
}

function dimensions(totals: FirstTurnTotals, baseline: FirstTurnBaseline): readonly Dimension[] {
  const ceilings = firstTurnCeilings(baseline);
  return [
    {
      label: "system prompt",
      unit: "tokens (est.)",
      measured: totals.systemPromptTokens,
      baseline: baseline.systemPromptTokens,
      ceiling: ceilings.systemPromptTokens,
    },
    {
      label: "tool schemas",
      unit: "tokens (est.)",
      measured: totals.toolSchemaTokens,
      baseline: baseline.toolSchemaTokens,
      ceiling: ceilings.toolSchemaTokens,
    },
    {
      label: "eager tool count",
      unit: "tools",
      measured: totals.toolCount,
      baseline: baseline.toolCount,
      ceiling: ceilings.toolCount,
    },
  ];
}

/** One message per exceeded part, naming the part and by how much it grew past its ceiling. */
export function firstTurnFailures(
  measurement: FirstTurnMeasurement,
  baseline: FirstTurnBaseline,
): readonly string[] {
  const totals = firstTurnTotals(measurement);
  const failures: string[] = [];
  for (const dimension of dimensions(totals, baseline)) {
    if (dimension.measured > dimension.ceiling) {
      const excess = dimension.measured - dimension.ceiling;
      failures.push(
        `${dimension.label}: ${String(dimension.measured)} ${dimension.unit} exceeds the ceiling of ${String(dimension.ceiling)} by ${String(excess)} (${percent(excess, dimension.ceiling)}); reviewed baseline ${String(dimension.baseline)}`,
      );
    }
  }
  return failures;
}

/** Parts that now sit more than their headroom below the baseline, so the baseline can drop. */
export function firstTurnLoweringHints(
  measurement: FirstTurnMeasurement,
  baseline: FirstTurnBaseline,
): readonly string[] {
  const totals = firstTurnTotals(measurement);
  const hints: string[] = [];
  for (const dimension of dimensions(totals, baseline)) {
    if (dimension.measured + (dimension.ceiling - dimension.baseline) < dimension.baseline) {
      hints.push(
        `${dimension.label} measures ${String(dimension.measured)} against a baseline of ${String(dimension.baseline)}: lower it in bench/budgets.json so the ceiling follows`,
      );
    }
  }
  return hints;
}

/** The largest schemas first; ties break by name so the output is stable. */
export function largestToolSchemas(
  toolSchemas: readonly ToolSchemaCost[],
  limit: number = BREAKDOWN_TOOL_LIMIT,
): readonly ToolSchemaCost[] {
  return [...toolSchemas]
    .sort((left, right) => right.tokens - left.tokens || left.name.localeCompare(right.name))
    .slice(0, limit);
}

export function formatFirstTurnReport(
  measurement: FirstTurnMeasurement,
  baseline: FirstTurnBaseline,
): string {
  const totals = firstTurnTotals(measurement);
  const ceilings = firstTurnCeilings(baseline);
  const lines = [
    "First-turn cost of the default agent (o200k token estimates, not provider counts)",
    `  system prompt  ${String(totals.systemPromptTokens).padStart(6)}  (ceiling ${String(ceilings.systemPromptTokens)})`,
    `  tool schemas   ${String(totals.toolSchemaTokens).padStart(6)}  (ceiling ${String(ceilings.toolSchemaTokens)})`,
    `  eager tools    ${String(totals.toolCount).padStart(6)}  (ceiling ${String(ceilings.toolCount)})`,
    `  total          ${String(totals.totalTokens).padStart(6)}`,
    "",
    `Largest ${String(BREAKDOWN_TOOL_LIMIT)} tool schemas`,
    ...largestToolSchemas(measurement.toolSchemas).map(
      (tool) => `  ${String(tool.tokens).padStart(6)}  ${tool.name}`,
    ),
  ];
  return lines.join("\n");
}
