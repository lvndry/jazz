/**
 * @fileoverview Runs goal cycles from the Jazz daemon and settles them.
 *
 * The decisions live in core (`goal-controls`, `goal-reconcile`, `goal-usage`); this module
 * does the I/O around them. A cycle is claimed durably before its run starts, runs as an
 * ordinary agent run in the goal's private conversation, and is settled through
 * `settleCycle` however it ends: finished here, resumed after an approval elsewhere, or
 * found dead by a later tick. Nothing is replayed after a crash; an unverifiable cycle is
 * left for the user to review.
 */

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { AgentRunner } from "@jazz/core/agent/agent-runner";
import {
  goalEvaluationRepairMessages,
  goalEvaluationSchemaForPlan,
  validateGoalEvaluation,
  type GoalEvaluationResult,
} from "@jazz/core/agent/goal/goal-evaluation";
import { goalCyclePrompt } from "@jazz/core/agent/goal/goal-prompt";
import { settleCycle, type EndedRun } from "@jazz/core/agent/goal/goal-reconcile";
import { asInput, type GoalCycle, type GoalRecord } from "@jazz/core/agent/goal/goal-record";
import {
  reachedLimit,
  remainingCaps,
  runSpend,
  type CycleCaps,
  type GoalLimit,
} from "@jazz/core/agent/goal/goal-usage";
import { isRunParkRequested, type RunParkRequested } from "@jazz/core/agent/run/park-signal";
import { resumeRun, type ResumeRunOptions } from "@jazz/core/agent/run/resume";
import type { RunRecord } from "@jazz/core/agent/run/run-record";
import type { AgentResponse } from "@jazz/core/agent/types";
import { AgentServiceTag } from "@jazz/core/interfaces/agent-service";
import { GoalStoreTag } from "@jazz/core/interfaces/goal-store";
import { LLMServiceTag } from "@jazz/core/interfaces/llm";
import { LoggerServiceTag } from "@jazz/core/interfaces/logger";
import { RunStoreTag } from "@jazz/core/interfaces/run-store";
import type { Agent } from "@jazz/core/types";
import type { ChatMessage } from "@jazz/core/types/message";
import { Effect } from "effect";
import {
  loadConversation,
  saveConversation,
} from "@jazz/adapters/history/conversation-history-service";

/**
 * Iterations one cycle may take before it must report. Each cycle ends with a disposition
 * the controller checks, so this sets how often progress is verified and persisted; the
 * goal's token, time, and cost caps are what bound the spend.
 */
const MAX_CYCLE_ITERATIONS = 24;

function processIsAlive(owner: GoalCycle["owner"]): boolean {
  if (owner.host !== hostname()) {
    return false;
  }
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function cappedBy(response: AgentResponse): Exclude<GoalLimit, "cycles"> | undefined {
  if (response.tokenCapped === true) {
    return "tokens";
  }
  if (response.durationCapped === true) {
    return "duration";
  }
  if (response.costCapped === true) {
    return "cost";
  }
  return undefined;
}

function endedRun(run: RunRecord | undefined): EndedRun | undefined {
  if (run === undefined) {
    return { kind: "missing" };
  }
  const spend = runSpend(run);
  switch (run.state.kind) {
    case "completed":
      return { kind: "completed", spend };
    case "failed":
      return { kind: "failed", error: run.state.error, spend };
    case "canceled":
      return { kind: "canceled", spend };
    default:
      return undefined;
  }
}

function saveGoalTranscript(goal: GoalRecord, messages: readonly ChatMessage[]) {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const prior = yield* loadConversation(goal.agentId, goal.conversationId).pipe(
      Effect.catchAll(() => Effect.succeed(null)),
    );
    yield* saveConversation({
      agentId: goal.agentId,
      conversationId: goal.conversationId,
      title: prior?.title ?? goal.plan.objective.slice(0, 80),
      startedAt: prior?.startedAt ?? new Date().toISOString(),
      endedAt: new Date().toISOString(),
      messages: [...messages],
    }).pipe(
      Effect.catchAll((error) =>
        logger.warn("Could not save the goal transcript", {
          goalId: goal.goalId,
          error: error.message,
        }),
      ),
    );
  });
}

/**
 * Check a completed cycle's disposition, with one schema-constrained repair pass when the
 * cycle's own answer does not validate. The repaired answer passes the same evidence check,
 * so repair can recover a misformatted disposition but never invent a completion.
 */
function evaluateCycle(goal: GoalRecord, cycleMessages: readonly ChatMessage[]) {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const assistantOutput = [...cycleMessages]
      .reverse()
      .find((message) => message.role === "assistant")?.content;
    if (assistantOutput === undefined) {
      return {
        evaluation: {
          kind: "invalid",
          reason: "The cycle ended without an answer.",
        } satisfies GoalEvaluationResult,
        repairTokens: 0,
        repairMs: 0,
      };
    }
    const first = validateGoalEvaluation(assistantOutput, goal.plan, cycleMessages);
    if (first.kind === "valid") {
      return { evaluation: first, repairTokens: 0, repairMs: 0 };
    }
    const agents = yield* AgentServiceTag;
    const llm = yield* LLMServiceTag;
    const startedAt = Date.now();
    const repaired = yield* Effect.gen(function* () {
      const agent = yield* agents.getAgent(goal.agentId);
      return yield* llm.createChatCompletion(agent.config.llmProvider, {
        model: agent.config.llmModel,
        messages: goalEvaluationRepairMessages(
          goal.plan,
          goal.lastProgress,
          assistantOutput,
          cycleMessages,
        ),
        temperature: 0,
        maxTokens: 1600,
        reasoning: "disable",
        outputSchema: goalEvaluationSchemaForPlan(goal.plan),
        ...(agent.config.llmApiKeys !== undefined
          ? { providerApiKeys: agent.config.llmApiKeys }
          : {}),
      });
    }).pipe(Effect.either);
    const repairMs = Date.now() - startedAt;
    if (repaired._tag === "Left") {
      yield* logger.warn("Could not repair the goal cycle disposition", {
        goalId: goal.goalId,
        error: repaired.left instanceof Error ? repaired.left.message : String(repaired.left),
      });
      return { evaluation: first, repairTokens: 0, repairMs };
    }
    const second = validateGoalEvaluation(repaired.right.content, goal.plan, cycleMessages);
    return {
      evaluation: second.kind === "valid" ? second : first,
      repairTokens: repaired.right.usage?.totalTokens ?? 0,
      repairMs,
    };
  });
}

/**
 * Settle the goal's open cycle for `runId` once its run has ended. `cycleMessages` are the
 * messages the cycle added; without them a completed run cannot be checked and goes to review.
 */
export function finishCycle(
  goalId: string,
  runId: string,
  cycleMessages: readonly ChatMessage[],
  runCap?: Exclude<GoalLimit, "cycles">,
) {
  return Effect.gen(function* () {
    const goals = yield* GoalStoreTag;
    const runs = yield* RunStoreTag;
    const goal = yield* goals.get(goalId);
    if (goal?.cycle?.runId !== runId) {
      return;
    }
    const run = yield* runs.get(runId);
    const ended = endedRun(run);
    if (ended === undefined) {
      return;
    }
    let settleGoal = goal;
    let evaluation: GoalEvaluationResult | undefined;
    if (ended.kind === "completed" && cycleMessages.length > 0) {
      const checked = yield* evaluateCycle(goal, cycleMessages);
      evaluation = checked.evaluation;
      if (checked.repairTokens > 0 || checked.repairMs > 0) {
        settleGoal = {
          ...goal,
          usage: {
            ...goal.usage,
            totalTokens: goal.usage.totalTokens + checked.repairTokens,
            activeDurationMs: goal.usage.activeDurationMs + checked.repairMs,
          },
        };
      }
    }
    const next = settleCycle(settleGoal, {
      run: ended,
      ...(evaluation !== undefined ? { evaluation } : {}),
      ...(runCap !== undefined ? { cappedBy: runCap } : {}),
    });
    yield* goals.compareAndSet(goal.goalId, goal.version, next).pipe(Effect.ignore);
  });
}

/**
 * Record that the goal's cycle run is parked on user input. A pause requested while it was
 * running takes effect now; a cancel cancels the parked run and settles the cycle.
 */
export function settleParkedCycle(goalId: string, runId: string) {
  return Effect.gen(function* () {
    const goals = yield* GoalStoreTag;
    const runs = yield* RunStoreTag;
    const goal = yield* goals.get(goalId);
    const cycle = goal?.cycle;
    if (goal === undefined || cycle?.runId !== runId) {
      return;
    }
    const run = yield* runs.get(runId);
    if (run?.state.kind !== "input-required") {
      return;
    }
    const reason = run.state.pending.kind === "tool-approval" ? "approval" : "question";
    if (cycle.stopAfter === "cancel") {
      yield* runs.transition(runId, { kind: "canceled", at: "parked" }).pipe(Effect.ignore);
      yield* finishCycle(goalId, runId, []);
      return;
    }
    if (cycle.stopAfter === "pause") {
      const { stopAfter: _stopAfter, ...openCycle } = cycle;
      yield* goals
        .compareAndSet(goal.goalId, goal.version, {
          ...asInput(goal),
          state: { kind: "paused" },
          cycle: openCycle,
        })
        .pipe(Effect.ignore);
      return;
    }
    if (goal.state.kind === "active" || goal.state.kind === "awaiting-input") {
      yield* goals
        .compareAndSet(goal.goalId, goal.version, {
          ...asInput(goal),
          state: { kind: "awaiting-input", reason },
        })
        .pipe(Effect.ignore);
    }
  });
}

function startCycle(goal: GoalRecord) {
  return Effect.gen(function* () {
    const goals = yield* GoalStoreTag;
    const agents = yield* AgentServiceTag;
    const limit = reachedLimit(goal);
    const caps = remainingCaps(goal);
    if (limit !== undefined || caps.kind === "limit") {
      yield* goals.compareAndSet(goal.goalId, goal.version, {
        ...asInput(goal),
        state: { kind: "budget-limited", limit: limit ?? (caps as { limit: GoalLimit }).limit },
      });
      return;
    }
    const agent = yield* agents.getAgent(goal.agentId).pipe(Effect.either);
    if (agent._tag === "Left") {
      yield* goals.compareAndSet(goal.goalId, goal.version, {
        ...asInput(goal),
        state: { kind: "review-required", reason: "The goal's agent is no longer available." },
      });
      return;
    }
    const prior = yield* loadConversation(goal.agentId, goal.conversationId).pipe(
      Effect.catchAll(() => Effect.succeed(null)),
    );
    const runId = randomUUID();
    const historyStart = prior?.messages.length ?? 0;
    const claimed = yield* goals
      .compareAndSet(goal.goalId, goal.version, {
        ...asInput(goal),
        state: { kind: "active" },
        cycle: { runId, owner: { pid: process.pid, host: hostname() }, historyStart },
        latestRunId: runId,
        usage: { ...goal.usage, cycles: goal.usage.cycles + 1 },
      })
      .pipe(Effect.either);
    if (claimed._tag === "Left") {
      return;
    }
    yield* runCycle(claimed.right, agent.right, runId, caps.caps, prior?.messages ?? []);
  });
}

function runCycle(
  goal: GoalRecord,
  agent: Agent,
  runId: string,
  caps: CycleCaps,
  history: readonly ChatMessage[],
) {
  return Effect.gen(function* () {
    const outcome = yield* AgentRunner.run({
      agent,
      runId,
      userInput: goalCyclePrompt(goal),
      conversationId: goal.conversationId,
      maxIterations: MAX_CYCLE_ITERATIONS,
      ...caps,
      parkWhenUnattended: true,
      conversationHistory: [...history],
    }).pipe(
      Effect.map((response): RunOutcome => ({ kind: "finished", response })),
      Effect.catchAll((error) => Effect.succeed(classifyRunError(error))),
    );
    yield* settleRunOutcome(goal, runId, history.length, outcome);
  });
}

export type RunOutcome =
  | { readonly kind: "finished"; readonly response: AgentResponse }
  | { readonly kind: "parked"; readonly park: RunParkRequested }
  | { readonly kind: "failed"; readonly error: string };

function classifyRunError(error: unknown): RunOutcome {
  if (isRunParkRequested(error)) {
    return { kind: "parked", park: error };
  }
  return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
}

function settleRunOutcome(
  goal: GoalRecord,
  runId: string,
  historyStart: number,
  outcome: RunOutcome,
) {
  return Effect.gen(function* () {
    if (outcome.kind === "parked") {
      if (outcome.park.messages !== undefined) {
        yield* saveGoalTranscript(goal, outcome.park.messages);
      }
      yield* settleParkedCycle(goal.goalId, runId);
      return;
    }
    if (outcome.kind === "failed") {
      yield* finishCycle(goal.goalId, runId, []);
      return;
    }
    const messages = outcome.response.messages ?? [];
    yield* saveGoalTranscript(goal, messages);
    yield* finishCycle(
      goal.goalId,
      runId,
      messages.slice(historyStart),
      cappedBy(outcome.response),
    );
  });
}

/** One daemon tick: settle cycles whose runs have moved on, then start due cycles. */
export function runDueGoals() {
  return Effect.gen(function* () {
    const goals = yield* GoalStoreTag;
    const runs = yield* RunStoreTag;
    const logger = yield* LoggerServiceTag;
    const candidates = yield* goals.list({ states: ["active", "awaiting-input", "stopping"] });
    for (const goal of candidates) {
      yield* Effect.gen(function* () {
        const cycle = goal.cycle;
        if (cycle === undefined) {
          if (goal.state.kind === "active") {
            yield* startCycle(goal);
          }
          return;
        }
        const run = yield* runs.get(cycle.runId);
        if (run === undefined || run.state.kind === "submitted") {
          if (!processIsAlive(cycle.owner)) {
            yield* finishCycle(goal.goalId, cycle.runId, []);
          }
          return;
        }
        if (run.state.kind === "working") {
          const owner = run.state.owner ?? cycle.owner;
          if (!processIsAlive(owner)) {
            yield* goals.compareAndSet(
              goal.goalId,
              goal.version,
              settleCycle(goal, {
                run: {
                  kind: "failed",
                  error: "the process running it stopped",
                  spend: runSpend(run),
                },
              }),
            );
          }
          return;
        }
        if (run.state.kind === "input-required") {
          yield* settleParkedCycle(goal.goalId, cycle.runId);
          return;
        }
        const prior = yield* loadConversation(goal.agentId, goal.conversationId).pipe(
          Effect.catchAll(() => Effect.succeed(null)),
        );
        yield* finishCycle(
          goal.goalId,
          cycle.runId,
          prior?.messages.slice(cycle.historyStart) ?? [],
        );
      }).pipe(
        Effect.catchAll((error) =>
          logger.warn("Goal tick failed", {
            goalId: goal.goalId,
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      );
    }
  });
}

/**
 * Answer a parked run, and when it belongs to a goal, settle the goal's cycle with the
 * result: finished, parked again on another approval, or failed. Every surface that answers
 * runs uses this, so none of them can leave the goal waiting on a run that has moved on.
 */
export function resumeGoalAwareRun(options: Omit<ResumeRunOptions, "goalLimits">) {
  return Effect.gen(function* () {
    const goals = yield* GoalStoreTag;
    const runs = yield* RunStoreTag;
    const candidates = yield* goals.list({ states: ["awaiting-input", "paused", "stopping"] });
    const goal = candidates.find((candidate) => candidate.cycle?.runId === options.runId);
    if (goal === undefined) {
      const response = yield* resumeRun(options);
      return { kind: "not-goal", response } as const;
    }
    if (goal.state.kind === "paused") {
      return {
        kind: "blocked",
        reason: `Goal ${goal.goalId} is paused; resume the goal before answering its run.`,
      } as const;
    }
    if (goal.state.kind === "stopping") {
      return {
        kind: "blocked",
        reason: `Goal ${goal.goalId} is stopping; wait for it to settle.`,
      } as const;
    }
    const run = yield* runs.get(options.runId);
    const caps = remainingCaps(goal, run === undefined ? undefined : runSpend(run));
    if (caps.kind === "limit") {
      return {
        kind: "blocked",
        reason: `Goal ${goal.goalId} reached its ${caps.limit} budget while waiting. Pause it and resume it to extend the budget, or cancel it.`,
      } as const;
    }
    const outcome = yield* resumeRun({ ...options, goalLimits: caps.caps }).pipe(
      Effect.map((response): RunOutcome => ({ kind: "finished", response })),
      Effect.catchAll((error) => Effect.succeed(classifyRunError(error))),
    );
    yield* settleRunOutcome(goal, options.runId, goal.cycle?.historyStart ?? 0, outcome);
    return { kind: "resumed", goalId: goal.goalId, outcome } as const;
  });
}

/** Apply a stop recorded on a goal whose cycle run is already parked. */
export function settleStoppingGoal(goalId: string) {
  return Effect.gen(function* () {
    const goals = yield* GoalStoreTag;
    const goal = yield* goals.get(goalId);
    if (goal?.state.kind === "stopping" && goal.cycle !== undefined) {
      yield* settleParkedCycle(goalId, goal.cycle.runId);
    }
  });
}
