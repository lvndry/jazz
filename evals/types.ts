export type Domain = "research" | "tooluse" | "planning" | "productivity" | "tutoring";

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

export interface EvalTask {
  id: string;
  domain: Domain;
  prompt: string;
  baseDifficulty?: "trivial" | "medium" | "hard";
  setup(workspaceDir: string): Promise<void>;
  check(result: OneShotResult, workspaceDir: string): Promise<CheckResult>;
  rubric?: RubricSpec;
}
