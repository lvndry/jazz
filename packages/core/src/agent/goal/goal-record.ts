/**
 * @fileoverview Durable user objective and its approved execution plan.
 *
 * GoalRecord is the controller-owned source of truth for a multi-run task. Plan steps and
 * evidence are metadata for orchestration; they do not grant tool permissions. Each run
 * keeps its own RunRecord and transcript, while this record preserves objective, plan,
 * ownership, aggregate budgets, and completion state across runs and client disconnects.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { generateConversationId } from "@/core/utils/conversation-id";
import { getGoalOwnerInstanceId } from "./goal-owner";
import type { GoalState } from "./goal-state";
import { DEFAULT_GOAL_BUDGET } from "./goal-usage";

export type GoalId = string;

/** Goal ids become file names, so they are limited to a path-safe alphabet. */
export const GOAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export type GoalStepState = "pending" | "active" | "completed" | "blocked";

export interface GoalPlanStep {
  readonly id: string;
  readonly objective: string;
  readonly successCriteria: readonly string[];
  readonly state: GoalStepState;
}

export const feasibilityAssessmentSchema = z.enum(["plausible", "uncertain", "unlikely"]);

export const goalLimitSchema = z.enum(["cycles", "tokens", "cost", "duration"]);

/** The cap a budget-limited goal reached. */
export type GoalLimit = z.infer<typeof goalLimitSchema>;

export interface GoalPlan {
  readonly revision: number;
  readonly objective: string;
  readonly successCriteria: readonly string[];
  readonly constraints: readonly string[];
  readonly assumptions: readonly string[];
  readonly feasibility: {
    readonly assessment: z.infer<typeof feasibilityAssessmentSchema>;
    readonly rationale: string;
  };
  readonly steps: readonly GoalPlanStep[];
  readonly verification: readonly string[];
}

export interface GoalBudget {
  readonly maxCycles: number;
  readonly maxTokens: number;
  readonly maxDurationMs: number;
  /** A dollar limit is enforced only when the provider pricing is known. */
  readonly maxCostUSD?: number;
  /**
   * Iterations one cycle may take before it must report and be checked. Shorter cycles
   * verify and persist progress more often at the cost of more checkpoints.
   */
  readonly maxIterationsPerCycle?: number;
}

export interface GoalUsage {
  readonly cycles: number;
  readonly totalTokens: number;
  /** Omitted while any contributing run has unknown pricing. */
  readonly costUSD?: number;
  readonly costKnown: boolean;
  readonly activeDurationMs: number;
}

/**
 * The cycle whose run has been claimed but whose outcome and usage are not yet folded into
 * the goal. Present exactly while that is true, so reconciling a cycle is one field cleared
 * rather than several kept in step.
 */
export interface GoalCycle {
  readonly runId: string;
  /** Process that started the run, for telling a crashed worker from a live one. */
  readonly owner: { readonly pid: number; readonly host: string };
  /** A pause or cancel requested while the run was in flight, applied once it settles. */
  readonly stopAfter?: "pause" | "cancel";
}

export interface GoalEvidenceItem {
  readonly criterion: string;
  readonly quote: string;
}

export interface GoalRecord {
  readonly goalId: GoalId;
  /** Stable owner identity for the Jazz installation that schedules this goal. */
  readonly ownerInstanceId: string;
  readonly agentId: string;
  /** Chat surface that proposed the goal; execution uses its own isolated conversation. */
  readonly sourceConversationId?: string;
  /** Private conversation owned by the goal controller, avoiding races with user chat turns. */
  readonly conversationId: string;
  /** The user's request, preserved verbatim as the root intent. */
  readonly request: string;
  /** The current plan proposal; editing it creates a new revision. */
  readonly plan: GoalPlan;
  /** Set only when the user approves this exact plan revision. */
  readonly approvedPlanRevision?: number;
  readonly state: GoalState;
  readonly budget: GoalBudget;
  readonly usage: GoalUsage;
  readonly cycle?: GoalCycle;
  /** The most recent cycle's run, kept after it is reconciled so it can be inspected. */
  readonly latestRunId?: string;
  /** Evidence that completed the goal, bound to the run and plan revision that produced it. */
  readonly evidence?: {
    readonly runId: string;
    readonly planRevision: number;
    readonly items: readonly GoalEvidenceItem[];
  };
  readonly lastProgress?: string;
  /**
   * Consecutive cycles whose completion claim failed its evidence check. Each gets another
   * cycle told what was missing; past a small limit the goal stops for review.
   */
  readonly unverifiedClaims?: number;
  /**
   * Cycles in a row cut off by the process stopping. Each one is continued by a fresh cycle
   * told to check the state first; past a small limit the goal stops for review.
   */
  readonly interruptedCycles?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Compare-and-set version for competing controls and continuation workers. */
  readonly version: number;
}

export type GoalRecordInput = Omit<GoalRecord, "version">;

/** The record with its open cycle folded away, for any transition that settles the cycle. */
export function withoutCycle(goal: GoalRecord | GoalRecordInput): GoalRecordInput {
  const { version: _version, cycle: _cycle, ...rest } = goal as GoalRecord;
  return rest;
}

/** The record ready for a compare-and-set write, keeping its open cycle. */
export function asInput(goal: GoalRecord): GoalRecordInput {
  const { version: _version, ...rest } = goal;
  return rest;
}

/** What a goal has spent before any cycle runs. */
export const NO_GOAL_USAGE: GoalUsage = {
  cycles: 0,
  totalTokens: 0,
  costUSD: 0,
  costKnown: true,
  activeDurationMs: 0,
};

/**
 * A new goal awaiting the user's acceptance, owned by this installation and running in its
 * own private conversation. `sourceConversationId` is the chat that proposed it, which scopes
 * the one-active-goal-per-conversation rule.
 */
export function newProposedGoal(options: {
  readonly agentId: string;
  readonly sourceConversationId: string | undefined;
  readonly request: string;
  readonly plan: GoalPlan;
  readonly budget?: GoalBudget;
  readonly usage?: GoalUsage;
}): GoalRecordInput {
  const now = new Date().toISOString();
  return {
    goalId: randomUUID(),
    ownerInstanceId: getGoalOwnerInstanceId(),
    agentId: options.agentId,
    ...(options.sourceConversationId !== undefined
      ? { sourceConversationId: options.sourceConversationId }
      : {}),
    conversationId: generateConversationId("goal"),
    request: options.request,
    plan: options.plan,
    state: { kind: "proposed" },
    budget: options.budget ?? DEFAULT_GOAL_BUDGET,
    usage: options.usage ?? NO_GOAL_USAGE,
    createdAt: now,
    updatedAt: now,
  };
}

/** A drafted plan's text: non-empty and bounded, so a runaway draft is rejected, not stored. */
export function boundedText(maxChars: number) {
  return z.string().min(1).max(maxChars);
}

/** Longest criterion, constraint, or step a draft may carry. */
export const DRAFT_ITEM_CHARS = 500;
const DRAFT_PARAGRAPH_CHARS = 1000;
/** Most criteria, constraints, or steps a draft may carry. */
export const DRAFT_MAX_LIST_ITEMS = 8;

/**
 * The plan fields every draft shares, whether the planner or the agent's `propose_goal`
 * wrote it. Each is described because a tool's parameters are advertised to the model.
 */
export const planDraftFields = {
  objective: boundedText(DRAFT_PARAGRAPH_CHARS).describe(
    "The outcome the user wants, in one sentence.",
  ),
  successCriteria: z
    .array(boundedText(DRAFT_ITEM_CHARS).describe("One criterion."))
    .min(1)
    .max(DRAFT_MAX_LIST_ITEMS)
    .describe(
      "Checks that together mean the goal is done, each one something a command or tool can print when it holds (a test run, a file's content, a check that echoes a confirmation).",
    ),
  constraints: z
    .array(boundedText(DRAFT_ITEM_CHARS).describe("One constraint."))
    .max(DRAFT_MAX_LIST_ITEMS)
    .describe("What must not change or be done."),
};

export const feasibilityDraftFields = {
  assessment: feasibilityAssessmentSchema.describe("plausible, uncertain, or unlikely."),
  rationale: boundedText(DRAFT_PARAGRAPH_CHARS).describe("Why, from what you have seen."),
};

export const FEASIBILITY_DESCRIPTION =
  "Whether the objective looks achievable from what you have seen, and why.";

const nonEmpty = z.string().min(1);
const nonNegativeInteger = z.number().int().nonnegative();
const positiveInteger = z.number().int().positive();

const goalStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("proposed") }),
  z.object({ kind: z.literal("active") }),
  z.object({ kind: z.literal("awaiting-input"), reason: z.enum(["question", "approval"]) }),
  z.object({ kind: z.literal("paused") }),
  z.object({ kind: z.literal("stopping") }),
  z.object({ kind: z.literal("budget-limited"), limit: goalLimitSchema }),
  z.object({
    kind: z.literal("review-required"),
    reason: z.string(),
    question: z.string().optional(),
  }),
  z.object({ kind: z.literal("completed"), summary: z.string() }),
  z.object({ kind: z.literal("failed"), error: z.string() }),
  z.object({ kind: z.literal("canceled") }),
]);

const planSchema = z.object({
  revision: positiveInteger,
  objective: z.string(),
  successCriteria: z.array(z.string()),
  constraints: z.array(z.string()),
  assumptions: z.array(z.string()),
  feasibility: z.object({ assessment: feasibilityAssessmentSchema, rationale: z.string() }),
  steps: z.array(
    z.object({
      id: nonEmpty,
      objective: z.string(),
      successCriteria: z.array(z.string()),
      state: z.enum(["pending", "active", "completed", "blocked"]),
    }),
  ),
  verification: z.array(z.string()),
});

const usageSchema = z
  .object({
    cycles: nonNegativeInteger,
    totalTokens: nonNegativeInteger,
    costUSD: z.number().finite().nonnegative().optional(),
    costKnown: z.boolean(),
    activeDurationMs: nonNegativeInteger,
  })
  .refine((usage) => usage.costKnown === (usage.costUSD !== undefined), {
    message: "costUSD is present exactly when costKnown is true",
  });

/** States in which a goal has a claimed cycle that has not been reconciled yet. */
const CYCLE_STATES = new Set(["active", "awaiting-input", "stopping", "paused"]);
/** States that cannot exist without such a cycle. */
const CYCLE_REQUIRED_STATES = new Set(["awaiting-input", "stopping"]);
/** States that act on an accepted plan, so they need that exact revision approved. */
const APPROVAL_REQUIRED_STATES = new Set([
  "active",
  "awaiting-input",
  "paused",
  "stopping",
  "budget-limited",
  "review-required",
  "completed",
  "failed",
]);

export const goalRecordSchema = z
  .object({
    goalId: z.string().regex(GOAL_ID_PATTERN),
    ownerInstanceId: nonEmpty,
    agentId: nonEmpty,
    sourceConversationId: z.string().optional(),
    conversationId: nonEmpty,
    request: z.string(),
    plan: planSchema,
    approvedPlanRevision: positiveInteger.optional(),
    state: goalStateSchema,
    budget: z.object({
      maxCycles: positiveInteger,
      maxTokens: positiveInteger,
      maxDurationMs: positiveInteger,
      maxCostUSD: z.number().finite().positive().optional(),
      maxIterationsPerCycle: positiveInteger.optional(),
    }),
    usage: usageSchema,
    cycle: z
      .object({
        runId: nonEmpty,
        owner: z.object({ pid: positiveInteger, host: z.string() }),
        stopAfter: z.enum(["pause", "cancel"]).optional(),
      })
      .optional(),
    latestRunId: z.string().optional(),
    evidence: z
      .object({
        runId: nonEmpty,
        planRevision: positiveInteger,
        items: z.array(z.object({ criterion: z.string(), quote: z.string() })),
      })
      .optional(),
    lastProgress: z.string().optional(),
    unverifiedClaims: positiveInteger.optional(),
    interruptedCycles: positiveInteger.optional(),
    createdAt: nonEmpty,
    updatedAt: nonEmpty,
    version: positiveInteger,
  })
  .superRefine((goal, context) => {
    const kind = goal.state.kind;
    if (goal.cycle !== undefined && !CYCLE_STATES.has(kind)) {
      context.addIssue({ code: "custom", message: `a ${kind} goal cannot have an open cycle` });
    }
    if (goal.cycle === undefined && CYCLE_REQUIRED_STATES.has(kind)) {
      context.addIssue({ code: "custom", message: `a ${kind} goal needs an open cycle` });
    }
    if (goal.cycle !== undefined && goal.cycle.runId !== goal.latestRunId) {
      context.addIssue({ code: "custom", message: "the open cycle must be the latest run" });
    }
    if (kind === "stopping" && goal.cycle?.stopAfter === undefined) {
      context.addIssue({ code: "custom", message: "a stopping goal must say what it stops into" });
    }
    if (APPROVAL_REQUIRED_STATES.has(kind) && goal.approvedPlanRevision !== goal.plan.revision) {
      context.addIssue({ code: "custom", message: `a ${kind} goal needs its plan approved` });
    }
    if (goal.approvedPlanRevision !== undefined && goal.approvedPlanRevision > goal.plan.revision) {
      context.addIssue({ code: "custom", message: "approval cannot be ahead of the plan" });
    }
    if (goal.evidence !== undefined && goal.evidence.planRevision !== goal.plan.revision) {
      context.addIssue({ code: "custom", message: "evidence must match the current plan" });
    }
    if (goal.evidence !== undefined && kind !== "completed") {
      context.addIssue({ code: "custom", message: "only a completed goal carries evidence" });
    }
  });

/** Validates a stored or about-to-be-stored record; the message names the broken invariant. */
export function parseGoalRecord(
  value: unknown,
):
  | { readonly ok: true; readonly goal: GoalRecord }
  | { readonly ok: false; readonly error: string } {
  const result = goalRecordSchema.safeParse(value);
  if (result.success) {
    return { ok: true, goal: result.data as GoalRecord };
  }
  return {
    ok: false,
    error: result.error.issues
      .map((issue) => `${issue.path.join(".") || "record"}: ${issue.message}`)
      .join("; "),
  };
}
