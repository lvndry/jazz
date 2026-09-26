/**
 * @fileoverview A loop: a prompt the daemon runs for an agent on a schedule, on one private
 * conversation, until it is ended.
 *
 * A loop is created by the user, never by an agent, and carries the authority granted then
 * (`approvalPolicy`). Each run is an ordinary run with its own run record; the loop keeps the
 * schedule, the budget across runs, the last outcome, and at most one run in flight, so it never
 * overlaps itself, including while a run waits for an approval.
 */

import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { SpendTotals } from "@/core/agent/run/run-spend";
import { APPROVAL_POLICY_LEVELS, type ApprovalPolicyLevel } from "@/core/types/tools";
import { generateConversationId } from "@/core/utils/conversation-id";
import type { ProcessOwner } from "@/core/utils/process";
import { getGoalOwnerInstanceId } from "../goal/goal-owner";

/**
 * The shortest interval a loop may run at. The daemon ticks every few seconds, and a prompt
 * re-run more often than once a minute is a busy-wait on a model, not a schedule.
 */
export const MIN_LOOP_INTERVAL_MS = 60_000;

/** Failed runs in a row after which a loop stops for the user instead of retrying forever. */
export const MAX_CONSECUTIVE_LOOP_FAILURES = 3;

export type LoopSchedule =
  | { readonly kind: "every"; readonly everyMs: number }
  /** A cron expression, read in `timezone` (an IANA name; UTC when absent). */
  | { readonly kind: "cron"; readonly expression: string; readonly timezone?: string };

export type LoopLimit = "runs" | "tokens" | "duration" | "cost";

export type LoopState =
  | { readonly kind: "active" }
  | { readonly kind: "paused" }
  /** It stopped retrying after failures in a row; resuming starts it again. */
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "budget-limited"; readonly limit: LoopLimit }
  /** Ended for good: by its own run (`end_loop`), its run limit, or its expiry. */
  | { readonly kind: "completed"; readonly reason: string }
  | { readonly kind: "canceled" };

export type LoopStateKind = LoopState["kind"];

export const TERMINAL_LOOP_STATES: readonly LoopStateKind[] = ["completed", "canceled"];

export interface LoopBudget {
  /** Runs the loop may start in total; unbounded when absent. */
  readonly maxRuns?: number;
  readonly maxTokens: number;
  /** Active time across all runs; waiting for an approval does not count. */
  readonly maxDurationMs: number;
  /** A dollar limit is enforced only when pricing is known. */
  readonly maxCostUSD?: number;
  /** Iterations one run may take. */
  readonly maxIterationsPerRun: number;
  /** When the loop ends on its own, as an ISO time. */
  readonly expiresAt?: string;
}

/**
 * Sized for a check that runs often: a single run with the default tools already costs tens of
 * thousands of prompt tokens, so the token cap covers a few dozen runs, and the dollar cap is
 * what stops a priced provider.
 */
export const DEFAULT_LOOP_BUDGET: LoopBudget = {
  maxTokens: 2_000_000,
  maxDurationMs: 2 * 60 * 60 * 1000,
  maxCostUSD: 5,
  maxIterationsPerRun: 24,
};

export interface LoopUsage extends SpendTotals {
  readonly runs: number;
}

export const NO_LOOP_USAGE: LoopUsage = {
  runs: 0,
  totalTokens: 0,
  costKnown: true,
  costUSD: 0,
  activeDurationMs: 0,
};

/** The run in flight, from its claim until its outcome is folded in. */
export interface LoopRun {
  readonly runId: string;
  readonly owner: ProcessOwner;
  readonly startedAt: string;
  /** A pause or cancel requested while the run was in flight, applied once it settles. */
  readonly stopAfter?: "pause" | "cancel";
}

export interface LoopLastRun {
  readonly runId: string;
  readonly finishedAt: string;
  readonly outcome: "completed" | "failed" | "interrupted" | "missing" | "canceled";
  /** The start of the run's answer, or of its error, for a listing. */
  readonly summary?: string;
}

export interface LoopRecord {
  readonly loopId: string;
  /** The Jazz installation that runs it; a daemon for another home never touches it. */
  readonly ownerInstanceId: string;
  readonly agentId: string;
  /** The loop's own conversation, which every run continues. */
  readonly conversationId: string;
  /** The chat it was started from, for listing it there. */
  readonly sourceConversationId?: string;
  /** Absolute directory every run works in. */
  readonly workingDirectory: string;
  readonly prompt: string;
  readonly schedule: LoopSchedule;
  /** The authority the user granted when starting it; absent means read-only and low-risk tools. */
  readonly approvalPolicy?: ApprovalPolicyLevel;
  readonly budget: LoopBudget;
  readonly usage: LoopUsage;
  readonly state: LoopState;
  readonly run?: LoopRun;
  readonly lastRun?: LoopLastRun;
  /** When the next run is due, as an ISO time. */
  readonly nextRunAt: string;
  /** Failed runs in a row; a run that finishes clears it. */
  readonly consecutiveFailures?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export type LoopRecordInput = Omit<LoopRecord, "version">;

export const LOOP_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const nonEmpty = z.string().min(1);
const isoTime = z.string().refine((value) => Number.isFinite(Date.parse(value)), "not a time");
const positiveInteger = z.number().int().positive();
const nonNegative = z.number().nonnegative();

const scheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("every"), everyMs: z.number().int().min(MIN_LOOP_INTERVAL_MS) }),
  z.object({ kind: z.literal("cron"), expression: nonEmpty, timezone: nonEmpty.optional() }),
]);

const stateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("active") }),
  z.object({ kind: z.literal("paused") }),
  z.object({ kind: z.literal("failed"), reason: z.string() }),
  z.object({
    kind: z.literal("budget-limited"),
    limit: z.enum(["runs", "tokens", "duration", "cost"]),
  }),
  z.object({ kind: z.literal("completed"), reason: z.string() }),
  z.object({ kind: z.literal("canceled") }),
]);

const ownerSchema = z.object({
  pid: positiveInteger,
  host: z.string(),
  startedAt: z.number().int().nonnegative().optional(),
});

export const loopRecordSchema = z
  .object({
    loopId: z.string().regex(LOOP_ID_PATTERN),
    ownerInstanceId: nonEmpty,
    agentId: nonEmpty,
    conversationId: nonEmpty,
    sourceConversationId: z.string().optional(),
    workingDirectory: z.string().refine(isAbsolute, "must be an absolute path"),
    prompt: z.string().min(1).max(4000),
    schedule: scheduleSchema,
    approvalPolicy: z.enum(APPROVAL_POLICY_LEVELS).optional(),
    budget: z.object({
      maxRuns: positiveInteger.optional(),
      maxTokens: positiveInteger,
      maxDurationMs: positiveInteger,
      maxCostUSD: z.number().finite().positive().optional(),
      maxIterationsPerRun: positiveInteger,
      expiresAt: isoTime.optional(),
    }),
    usage: z.object({
      runs: z.number().int().nonnegative(),
      totalTokens: nonNegative,
      costUSD: nonNegative.optional(),
      costKnown: z.boolean(),
      activeDurationMs: nonNegative,
    }),
    state: stateSchema,
    run: z
      .object({
        runId: nonEmpty,
        owner: ownerSchema,
        startedAt: isoTime,
        stopAfter: z.enum(["pause", "cancel"]).optional(),
      })
      .optional(),
    lastRun: z
      .object({
        runId: nonEmpty,
        finishedAt: isoTime,
        outcome: z.enum(["completed", "failed", "interrupted", "missing", "canceled"]),
        summary: z.string().optional(),
      })
      .optional(),
    nextRunAt: isoTime,
    consecutiveFailures: positiveInteger.optional(),
    createdAt: nonEmpty,
    updatedAt: nonEmpty,
    version: positiveInteger,
  })
  .superRefine((loop, context) => {
    if (loop.run !== undefined && loop.state.kind !== "active") {
      context.addIssue({
        code: "custom",
        message: `a ${loop.state.kind} loop cannot have a run in flight`,
      });
    }
  });

export function parseLoopRecord(
  value: unknown,
):
  | { readonly ok: true; readonly loop: LoopRecord }
  | { readonly ok: false; readonly error: string } {
  const parsed = loopRecordSchema.safeParse(value);
  if (parsed.success) {
    return { ok: true, loop: parsed.data as LoopRecord };
  }
  return {
    ok: false,
    error: parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "record"}: ${issue.message}`)
      .join("; "),
  };
}

export function isTerminalLoop(state: LoopState): boolean {
  return TERMINAL_LOOP_STATES.includes(state.kind);
}

/** A new, active loop whose first run is due at `firstRunAt`. */
export function newLoop(options: {
  readonly agentId: string;
  readonly prompt: string;
  readonly schedule: LoopSchedule;
  readonly workingDirectory: string;
  readonly firstRunAt: Date;
  readonly sourceConversationId?: string;
  readonly approvalPolicy?: ApprovalPolicyLevel;
  readonly budget?: Partial<LoopBudget>;
}): LoopRecordInput {
  const now = new Date().toISOString();
  return {
    loopId: randomUUID(),
    ownerInstanceId: getGoalOwnerInstanceId(),
    agentId: options.agentId,
    conversationId: generateConversationId("loop"),
    ...(options.sourceConversationId !== undefined
      ? { sourceConversationId: options.sourceConversationId }
      : {}),
    workingDirectory: options.workingDirectory,
    prompt: options.prompt,
    schedule: options.schedule,
    ...(options.approvalPolicy !== undefined ? { approvalPolicy: options.approvalPolicy } : {}),
    budget: { ...DEFAULT_LOOP_BUDGET, ...options.budget },
    usage: NO_LOOP_USAGE,
    state: { kind: "active" },
    nextRunAt: options.firstRunAt.toISOString(),
    createdAt: now,
    updatedAt: now,
  };
}

/** The loop with its in-flight run folded away. */
export function withoutRun(loop: LoopRecord | LoopRecordInput): LoopRecordInput {
  const { run: _run, version: _version, ...rest } = loop as LoopRecord;
  return rest;
}
