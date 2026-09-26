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
import { cycleMessages, goalCyclePrompt } from "@jazz/core/agent/goal/goal-prompt";
import { settleCycle, type EndedRun } from "@jazz/core/agent/goal/goal-reconcile";
import {
  asInput,
  type GoalCycle,
  type GoalLimit,
  type GoalRecord,
  type GoalRecordInput,
} from "@jazz/core/agent/goal/goal-record";
import { CLAIMED_GOAL_STATES } from "@jazz/core/agent/goal/goal-state";
import {
  addSpend,
  reachedLimit,
  remainingCaps,
  runSpend,
  type RunSpend,
  type CycleCaps,
} from "@jazz/core/agent/goal/goal-usage";
import { runToOutcome, type RunOutcome } from "@jazz/core/agent/run/park-signal";
import { resumeRun, type ResumeRunOptions } from "@jazz/core/agent/run/resume";
import type { RunRecord } from "@jazz/core/agent/run/run-record";
import { priceOneOffCall } from "@jazz/core/agent/run/run-spend";
import { reparkedState } from "@jazz/core/agent/run/run-state";
import type { AgentResponse } from "@jazz/core/agent/types";
import { AgentServiceTag } from "@jazz/core/interfaces/agent-service";
import { GoalStoreTag } from "@jazz/core/interfaces/goal-store";
import { LLMServiceTag } from "@jazz/core/interfaces/llm";
import { LoggerServiceTag } from "@jazz/core/interfaces/logger";
import { RunStoreTag } from "@jazz/core/interfaces/run-store";
import type { Agent } from "@jazz/core/types";
import type { ChatMessage } from "@jazz/core/types/message";
import { currentProcessOwner, localOwnerStatus } from "@jazz/core/utils/process";
import { toError } from "@jazz/core/utils/storage";
import { Cause, Effect, Fiber } from "effect";
import {
  loadConversationOrNull,
  saveRunTranscript,
} from "@jazz/adapters/history/conversation-history-service";

/**
 * Iterations one cycle may take before it must report, unless the goal's budget sets its
 * own. Each cycle ends with a disposition the controller checks, so this sets how often
 * progress is verified and persisted; the goal's token, time, and cost caps bound the spend.
 */
const DEFAULT_CYCLE_ITERATIONS = 24;

/** A disposition is a small JSON object; this bounds a repair call that would ramble. */
const REPAIR_MAX_OUTPUT_TOKENS = 1_600;

/**
 * Cycle runs this process is executing right now. A cycle whose owner pid is this process
 * but which is not in the set died here (a defect, an interrupt) and will not settle itself.
 */
const cyclesInFlight = new Set<string>();

/**
 * Whether a cycle's run is still being worked on. This process's own in-flight set is checked
 * first, so a hostname change mid-cycle cannot make the daemon disown a cycle it is running.
 */
function cycleOwnerStatus(
  owner: GoalCycle["owner"],
  runId: string,
): "alive" | "gone" | "unverifiable" {
  if (cyclesInFlight.has(runId)) {
    return "alive";
  }
  if (owner.pid === process.pid && owner.host === hostname()) {
    return "gone";
  }
  return localOwnerStatus(owner);
}

/** Mark a cycle run as executing in this process for the duration of `work`. */
function inFlight<A, E, R>(runId: string, work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.sync(() => cyclesInFlight.add(runId)),
    () => work,
    () => Effect.sync(() => cyclesInFlight.delete(runId)),
  );
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
      return run.state.cause === "interrupted"
        ? { kind: "interrupted", spend }
        : { kind: "failed", error: run.state.error, spend };
    case "canceled":
      return { kind: "canceled", spend };
    default:
      return undefined;
  }
}

/**
 * Compare-and-set a goal, logging a refused write instead of failing the caller. A version
 * conflict means another writer moved the goal first and the next tick sees its state; an
 * invariant violation is a bug, and the log names it rather than leaving the goal silently
 * where it was.
 */
function writeGoal(goal: GoalRecord, next: GoalRecordInput, purpose: string) {
  return Effect.gen(function* () {
    const goals = yield* GoalStoreTag;
    const logger = yield* LoggerServiceTag;
    yield* goals.compareAndSet(goal.goalId, goal.version, next).pipe(
      Effect.catchAll((error) =>
        logger.warn(`Could not update goal to ${purpose}`, {
          goalId: goal.goalId,
          from: goal.state.kind,
          to: next.state.kind,
          error: error.message,
        }),
      ),
    );
  });
}

function saveGoalTranscript(goal: GoalRecord, messages: readonly ChatMessage[]) {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const prior = yield* loadConversationOrNull(goal.agentId, goal.conversationId);
    yield* saveRunTranscript({
      agentId: goal.agentId,
      conversationId: goal.conversationId,
      prior,
      fallbackTitle: goal.plan.objective,
      messages,
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

const NO_REPAIR: RunSpend = { totalTokens: 0, costUSD: 0, activeDurationMs: 0 };

/** What the repair call spent, so the goal is charged for it. */
function repairSpend(
  agent: Agent,
  usage: Parameters<typeof priceOneOffCall>[1],
  durationMs: number,
) {
  return priceOneOffCall(agent, usage).pipe(
    Effect.map((price): RunSpend => ({
      totalTokens: price.totalTokens,
      ...(price.costUSD !== undefined ? { costUSD: price.costUSD } : {}),
      activeDurationMs: durationMs,
    })),
  );
}

/**
 * Check a completed cycle's disposition, with one schema-constrained repair pass when the
 * cycle's own answer does not validate. The repaired answer passes the same evidence check,
 * so repair can recover a misformatted disposition but never invent a completion. Returns
 * the repair's spend so the goal is charged for it.
 */
function evaluateCycle(goal: GoalRecord, cycleMessages: readonly ChatMessage[]) {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const assistantOutput = [...cycleMessages]
      .reverse()
      .find((message) => message.role === "assistant")?.content;
    if (assistantOutput === undefined) {
      const evaluation: GoalEvaluationResult = {
        kind: "invalid",
        reason: "The cycle ended without an answer.",
      };
      return { evaluation, repair: NO_REPAIR };
    }
    const first = validateGoalEvaluation(assistantOutput, goal.plan, cycleMessages);
    if (first.kind === "valid") {
      return { evaluation: first, repair: NO_REPAIR };
    }
    const agents = yield* AgentServiceTag;
    const llm = yield* LLMServiceTag;
    const agent = yield* agents.getAgent(goal.agentId);
    const startedAt = Date.now();
    const repaired = yield* llm
      .createChatCompletion(agent.config.llmProvider, {
        model: agent.config.llmModel,
        messages: goalEvaluationRepairMessages(
          goal.plan,
          goal.lastProgress,
          assistantOutput,
          cycleMessages,
        ),
        temperature: 0,
        maxTokens: REPAIR_MAX_OUTPUT_TOKENS,
        reasoning: "disable",
        outputSchema: goalEvaluationSchemaForPlan(goal.plan),
        ...(agent.config.llmApiKeys !== undefined
          ? { providerApiKeys: agent.config.llmApiKeys }
          : {}),
      })
      .pipe(Effect.either);
    const repairMs = Date.now() - startedAt;
    if (repaired._tag === "Left") {
      yield* logger.warn("Could not repair the goal cycle disposition", {
        goalId: goal.goalId,
        error: toError(repaired.left).message,
      });
      return { evaluation: first, repair: yield* repairSpend(agent, undefined, repairMs) };
    }
    const second = validateGoalEvaluation(repaired.right.content, goal.plan, cycleMessages);
    return {
      evaluation: second.kind === "valid" ? second : first,
      repair: yield* repairSpend(agent, repaired.right.usage, repairMs),
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
      settleGoal = { ...goal, usage: addSpend(goal.usage, checked.repair) };
    }
    const next = settleCycle(settleGoal, {
      run: ended,
      ...(evaluation !== undefined ? { evaluation } : {}),
      ...(runCap !== undefined ? { cappedBy: runCap } : {}),
    });
    yield* writeGoal(goal, next, "settle its cycle");
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
      yield* runs.transition(runId, { kind: "canceled", at: "parked" }).pipe(
        Effect.catchAll((error) =>
          Effect.flatMap(LoggerServiceTag, (logger) =>
            logger.warn("Could not cancel a canceled goal's parked run", {
              goalId,
              runId,
              error: error.message,
            }),
          ),
        ),
      );
      yield* finishCycle(goalId, runId, []);
      return;
    }
    if (cycle.stopAfter === "pause") {
      const { stopAfter: _stopAfter, ...openCycle } = cycle;
      yield* writeGoal(
        goal,
        { ...asInput(goal), state: { kind: "paused" }, cycle: openCycle },
        "pause at its parked run",
      );
      return;
    }
    if (goal.state.kind === "active" || goal.state.kind === "awaiting-input") {
      yield* writeGoal(
        goal,
        { ...asInput(goal), state: { kind: "awaiting-input", reason } },
        "wait for input",
      );
    }
  });
}

/**
 * Claim a cycle for a due goal. Returns the run to start, or nothing when the goal hit a
 * limit or another writer claimed it first. The claim is durable before any work begins.
 */
function claimCycle(goal: GoalRecord) {
  return Effect.gen(function* () {
    const agents = yield* AgentServiceTag;
    const limit = reachedLimit(goal);
    const caps = remainingCaps(goal);
    if (limit !== undefined || caps.kind === "limit") {
      yield* writeGoal(
        goal,
        {
          ...asInput(goal),
          state: { kind: "budget-limited", limit: limit ?? (caps as { limit: GoalLimit }).limit },
        },
        "stop at its budget",
      );
      return undefined;
    }
    const agent = yield* agents.getAgent(goal.agentId).pipe(Effect.either);
    if (agent._tag === "Left") {
      yield* writeGoal(
        goal,
        {
          ...asInput(goal),
          state: { kind: "review-required", reason: "The goal's agent is no longer available." },
        },
        "report its missing agent",
      );
      return undefined;
    }
    const goals = yield* GoalStoreTag;
    const runId = randomUUID();
    const claimed = yield* goals
      .compareAndSet(goal.goalId, goal.version, {
        ...asInput(goal),
        state: { kind: "active" },
        cycle: { runId, owner: currentProcessOwner() },
        latestRunId: runId,
        usage: { ...goal.usage, cycles: goal.usage.cycles + 1 },
      })
      .pipe(Effect.either);
    if (claimed._tag === "Left") {
      return undefined;
    }
    return { goal: claimed.right, agent: agent.right, runId, caps: caps.caps };
  });
}

function runCycle(goal: GoalRecord, agent: Agent, runId: string, caps: CycleCaps) {
  return Effect.gen(function* () {
    const prior = yield* loadConversationOrNull(goal.agentId, goal.conversationId);
    const outcome = yield* runToOutcome(
      AgentRunner.run({
        agent,
        runId,
        userInput: goalCyclePrompt(goal, runId),
        conversationId: goal.conversationId,
        maxIterations: goal.budget.maxIterationsPerCycle ?? DEFAULT_CYCLE_ITERATIONS,
        ...caps,
        ...(goal.approvalPolicy !== undefined ? { autoApprovePolicy: goal.approvalPolicy } : {}),
        parkWhenUnattended: true,
        conversationHistory: [...(prior?.messages ?? [])],
      }),
    );
    yield* settleRunOutcome(goal, runId, outcome);
  });
}

function settleRunOutcome(goal: GoalRecord, runId: string, outcome: RunOutcome<AgentResponse>) {
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
      cycleMessages(messages, runId),
      cappedBy(outcome.response),
    );
  });
}

/**
 * Settle a cycle whose run is `working` but whose process is gone. A resumed run carries its
 * parked snapshot, so it goes back to waiting for its answer; anything else failed, and the
 * run is closed too so nothing can re-park and run it outside the goal later.
 */
/**
 * A cycle whose process cannot be checked from here (another host, or a start time `ps`
 * cannot read) is neither trusted as running nor replayed: the goal stops for review, and a
 * cancel already requested on it is applied.
 */
function settleUnverifiableCycle(goal: GoalRecord) {
  return writeGoal(
    goal,
    settleCycle(goal, {
      run: { kind: "missing" },
      unchecked:
        "Jazz cannot tell whether the process running this cycle is still working (it ran on another host, or its process cannot be inspected); check for side effects before continuing.",
    }),
    "stop a cycle whose owner cannot be verified",
  );
}

function settleDeadWorkingRun(goal: GoalRecord, run: RunRecord) {
  return Effect.gen(function* () {
    const runs = yield* RunStoreTag;
    if (run.state.kind !== "working") {
      return;
    }
    const recovery = run.state.recovery;
    if (recovery !== undefined) {
      yield* runs.transition(run.runId, reparkedState(recovery));
      yield* settleParkedCycle(goal.goalId, run.runId);
      return;
    }
    const error = "the process running it stopped";
    yield* runs
      .transition(run.runId, { kind: "failed", cause: "interrupted", error })
      .pipe(Effect.catchAll(() => Effect.void));
    yield* finishCycle(goal.goalId, run.runId, []);
  });
}

/**
 * One daemon tick: settle cycles whose runs have moved on and start due cycles. A started
 * cycle runs on its own fiber so one long cycle does not hold up triggers, workflows, or
 * other goals; the fibers are returned for callers that want to wait on them.
 */
export function runDueGoals() {
  return Effect.gen(function* () {
    const goals = yield* GoalStoreTag;
    const runs = yield* RunStoreTag;
    const logger = yield* LoggerServiceTag;
    const started: Fiber.RuntimeFiber<void, never>[] = [];
    const candidates = yield* goals.list({ states: CLAIMED_GOAL_STATES });
    for (const goal of candidates) {
      yield* Effect.gen(function* () {
        const cycle = goal.cycle;
        if (cycle === undefined) {
          if (goal.state.kind !== "active") {
            return;
          }
          const claim = yield* claimCycle(goal);
          if (claim !== undefined) {
            started.push(
              yield* inFlight(
                claim.runId,
                runCycle(claim.goal, claim.agent, claim.runId, claim.caps),
              ).pipe(
                Effect.catchAllCause((cause) =>
                  logger.warn("Goal cycle failed to settle", {
                    goalId: goal.goalId,
                    error: Cause.pretty(cause),
                  }),
                ),
                Effect.forkDaemon,
              ),
            );
          }
          return;
        }
        const cycleOwner = cycleOwnerStatus(cycle.owner, cycle.runId);
        if (cycleOwner === "alive") {
          return;
        }
        if (cycleOwner === "unverifiable") {
          yield* settleUnverifiableCycle(goal);
          return;
        }
        const run = yield* runs.get(cycle.runId);
        if (run?.state.kind === "submitted") {
          yield* runs
            .transition(run.runId, {
              kind: "failed",
              cause: "error",
              error: "the process that submitted it stopped before it started",
            })
            .pipe(Effect.catchAll(() => Effect.void));
        }
        if (run === undefined || run.state.kind === "submitted") {
          yield* finishCycle(goal.goalId, cycle.runId, []);
          return;
        }
        if (run.state.kind === "working") {
          const runOwner = cycleOwnerStatus(run.state.owner ?? cycle.owner, cycle.runId);
          if (runOwner === "gone") {
            yield* settleDeadWorkingRun(goal, run);
          } else if (runOwner === "unverifiable") {
            yield* settleUnverifiableCycle(goal);
          }
          return;
        }
        if (run.state.kind === "input-required") {
          yield* settleParkedCycle(goal.goalId, cycle.runId);
          return;
        }
        const prior = yield* loadConversationOrNull(goal.agentId, goal.conversationId);
        yield* finishCycle(
          goal.goalId,
          cycle.runId,
          cycleMessages(prior?.messages ?? [], cycle.runId),
        );
      }).pipe(
        Effect.catchAllCause((cause) =>
          logger.warn("Goal tick failed", { goalId: goal.goalId, error: Cause.pretty(cause) }),
        ),
      );
    }
    return started;
  });
}

/**
 * Answer a parked run, and when it belongs to a goal, settle the goal's cycle with the
 * result: finished, parked again on another approval, or failed. The goal is active again
 * while the answered run works, so a pause or cancel in that window is recorded on the
 * cycle instead of being lost. Every surface that answers runs uses this.
 */
export function resumeGoalAwareRun(options: Omit<ResumeRunOptions, "goalLimits">) {
  return Effect.gen(function* () {
    const goals = yield* GoalStoreTag;
    const runs = yield* RunStoreTag;
    const candidates = yield* goals.list({
      states: ["active", "awaiting-input", "paused", "stopping"],
    });
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
        reason: `Goal ${goal.goalId} reached its ${caps.limit} budget while waiting. Pause and resume the goal to extend its budget, or cancel it.`,
      } as const;
    }
    const working = yield* goals
      .compareAndSet(goal.goalId, goal.version, { ...asInput(goal), state: { kind: "active" } })
      .pipe(Effect.either);
    if (working._tag === "Left") {
      return {
        kind: "blocked",
        reason: `Goal ${goal.goalId} changed while answering; check /goal list and retry.`,
      } as const;
    }
    const outcome = yield* inFlight(
      options.runId,
      Effect.gen(function* () {
        const settled = yield* runToOutcome(resumeRun({ ...options, goalLimits: caps.caps }));
        yield* settleRunOutcome(working.right, options.runId, settled);
        return settled;
      }),
    );
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
