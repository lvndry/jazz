export type Domain =
  "research" | "tooluse" | "planning" | "productivity" | "tutoring" | "grounding" | "continuity";

export interface OneShotResult {
  ok: boolean;
  answer: string;
  toolCalls: { id: string; name: string; arguments: string }[];
  costUSD: number;
  tokenUsage: { promptTokens: number; completionTokens: number; totalTokens: number };
  eventsPath: string; // path to captured --events NDJSON for this rollout
}

export interface CheckResult {
  pass: boolean;
  score: number; // 0..1
  detail: string;
}

export interface RubricSpec {
  criteria: string; // what the judge scores, e.g. "clarity and pedagogy 0-1"
}

/**
 * What a task needs to drive jazz itself, for tasks that are not one prompt in and
 * one answer out.
 */
export interface TaskRunContext {
  agentId: string;
  workspaceDir: string;
  cassettePath: string;
  timeoutMs: number;
  runId: string;
  /**
   * Private JAZZ_HOME for this rollout. Continuity tasks seed working state here and
   * assert on what survives, which the real ~/.jazz cannot give them — and writing
   * fixture state into the user's home would be wrong regardless.
   */
  jazzHome: string;
}

export interface EvalTask {
  id: string;
  domain: Domain;
  prompt: string;
  baseDifficulty?: "trivial" | "medium" | "hard";
  setup(workspaceDir: string): void | Promise<void>;
  check(result: OneShotResult, workspaceDir: string): CheckResult | Promise<CheckResult>;
  rubric?: RubricSpec;
  /**
   * Override the single-shot rollout. Present only for tasks that need several jazz
   * invocations against one conversation — resuming after a kill, handing state to a
   * fresh agent. The returned result is what `check` receives, and should be the run
   * whose answer is being judged (the resume, not the setup run).
   */
  run?(context: TaskRunContext): Promise<OneShotResult>;
}
