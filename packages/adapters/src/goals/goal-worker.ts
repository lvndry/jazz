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
  type GoalLimit,
  type GoalRecord,
  type GoalRecordInput,
} from "@jazz/core/agent/goal/goal-record";
import { CLAIMED_GOAL_STATES } from "@jazz/core/agent/goal/goal-state";
import { addSpend, reachedLimit } from "@jazz/core/agent/goal/goal-usage";
import { runToOutcome, type RunOutcome } from "@jazz/core/agent/run/park-signal";
import { resumeRun, type ResumeRunOptions } from "@jazz/core/agent/run/resume";
import type { RunRecord } from "@jazz/core/agent/run/run-record";
import { priceOneOffCall, runSpend, type RunSpend } from "@jazz/core/agent/run/run-spend";
import { reparkedState } from "@jazz/core/agent/run/run-state";
import { goalCycleReport } from "@jazz/core/agent/tools/goal-report";
import type { AgentResponse, AgentRunnerOptions } from "@jazz/core/agent/types";
import { AgentConfigServiceTag } from "@jazz/core/interfaces/agent-config";
import { AgentServiceTag } from "@jazz/core/interfaces/agent-service";
import { FileSystemContextServiceTag } from "@jazz/core/interfaces/fs";
import { GoalStoreTag } from "@jazz/core/interfaces/goal-store";
import { LLMServiceTag } from "@jazz/core/interfaces/llm";
import { LoggerServiceTag } from "@jazz/core/interfaces/logger";
import { RunStoreTag } from "@jazz/core/interfaces/run-store";
import { nextCycleBlockedBySpend } from "@jazz/core/spend/run-accounting";
import type { Agent } from "@jazz/core/types";
import type { ChatMessage } from "@jazz/core/types/message";
import { toError } from "@jazz/core/utils/errors";
import { currentProcessOwner, localOwnerStatus } from "@jazz/core/utils/process";
import { Cause, Effect, Fiber } from "effect";
import { claimOwnerStatus, inFlight } from "@/adapters/runs/runs-in-flight";
import {
  loadConversationOrNull,
  saveRunTranscript,
  type Conversation,
} from "@jazz/adapters/history/conversation-history-service";

/** A goal without a name is shown by the start of its id, as `jazz goal` commands accept it. */
const GOAL_ID_PREFIX_CHARS = 8;

/** How the ledger and notifications name a goal: the same label `jazz daemon status` shows. */
function goalName(goal: GoalRecord): string {
  return goal.name ?? goal.goalId.slice(0, GOAL_ID_PREFIX_CHARS);
}

/** A disposition is a small JSON object; this bounds a repair call that would ramble. */
const REPAIR_MAX_OUTPUT_TOKENS = 1_600;

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

/** `prior` is the conversation as the cycle loaded it before running, which the save builds on. */
function saveGoalTranscript(
  goal: GoalRecord,
  prior: Conversation | null,
  messages: readonly ChatMessage[],
) {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
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
    const reported = goalCycleReport(cycleMessages);
    if (reported === undefined && assistantOutput === undefined) {
      const evaluation: GoalEvaluationResult = {
        kind: "invalid",
        reason: "The cycle ended without an answer.",
      };
      return { evaluation, repair: NO_REPAIR };
    }
    const first = validateGoalEvaluation(
      reported ?? assistantOutput ?? "",
      goal.plan,
      cycleMessages,
    );
    if (first.kind === "valid") {
      return { evaluation: first, repair: NO_REPAIR };
    }
    const agents = yield* AgentServiceTag;
    const llm = yield* LLMServiceTag;
    const agent = yield* agents.getAgent(goal.agentId);
    const startedAt = Date.now();
    const repaired = yield* llm
      .createChatCompletion(agent.config.llm.provider, {
        model: agent.config.llm.model,
        messages: goalEvaluationRepairMessages(
          goal.plan,
          goal.lastProgress,
          assistantOutput ?? reported ?? "",
          cycleMessages,
        ),
        temperature: 0,
        maxTokens: REPAIR_MAX_OUTPUT_TOKENS,
        reasoning: "disable",
        outputSchema: goalEvaluationSchemaForPlan(goal.plan),
        ...(agent.config.llm.apiKeys !== undefined
          ? { providerApiKeys: agent.config.llm.apiKeys }
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
      evaluation: second.kind === "valid" ? withRejection(second, first, reported) : first,
      repair: yield* repairSpend(agent, repaired.right.usage, repairMs),
    };
  });
}

/**
 * A repaired disposition that carries on the goal, told why the cycle's own report was not
 * accepted, so the next cycle fixes the report instead of redoing work that is already done.
 */
function withRejection(
  repaired: Extract<GoalEvaluationResult, { kind: "valid" }>,
  rejected: GoalEvaluationResult,
  reported: string | undefined,
): GoalEvaluationResult {
  const { evaluation } = repaired;
  if (rejected.kind !== "invalid" || reported === undefined || evaluation.status !== "continue") {
    return repaired;
  }
  return {
    kind: "valid",
    evaluation: {
      ...evaluation,
      nextAction: `${evaluation.nextAction} The last report_goal_cycle was not accepted: ${rejected.reason} If the work is done, report again with quotes copied word for word from tool output.`,
    },
  };
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
    if (limit !== undefined) {
      yield* writeGoal(
        goal,
        { ...asInput(goal), state: { kind: "budget-limited", limit } },
        "stop at its cycle cap",
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
    return { goal: claimed.right, agent: agent.right, runId };
  });
}

function runCycle(goal: GoalRecord, agent: Agent, runId: string) {
  return Effect.gen(function* () {
    const fileSystemContext = yield* FileSystemContextServiceTag;
    const placed = yield* fileSystemContext
      .setCwd({ agentId: goal.agentId, conversationId: goal.conversationId }, goal.workingDirectory)
      .pipe(Effect.either);
    if (placed._tag === "Left") {
      yield* writeGoal(
        goal,
        settleCycle(goal, {
          run: { kind: "missing" },
          unchecked: `The goal's directory, ${goal.workingDirectory}, is gone or unreadable, so no cycle ran there.`,
        }),
        "stop a cycle whose working directory is gone",
      );
      return "settled";
    }
    const prior = yield* loadConversationOrNull(goal.agentId, goal.conversationId);
    const outcome = yield* runToOutcome(
      AgentRunner.run({
        agent,
        runId,
        userInput: goalCyclePrompt(goal, runId),
        conversationId: goal.conversationId,
        ...(goal.approvalPolicy !== undefined ? { autoApprovePolicy: goal.approvalPolicy } : {}),
        parkWhenUnattended: true,
        startedBy: "goal",
        origin: { source: "goal", name: goalName(goal) },
        conversationHistory: [...(prior?.messages ?? [])],
      }),
    );
    if (outcome.kind === "finished" && outcome.response.interrupted === true) {
      yield* settleInterruptedCycle(goal, runId, outcome.response.messages ?? [], {
        saveOnto: prior,
      });
      return "interrupted";
    }
    yield* settleRunOutcome(goal, runId, outcome, { saveOnto: prior });
    return "settled";
  });
}

/**
 * The user stopped a cycle running in front of them. Its work so far is kept and the goal is
 * paused, so nothing carries on that they did not ask for; resuming continues from the
 * transcript. A cancel already recorded on the cycle still wins.
 */
/**
 * Where a settled cycle's transcript goes: the worker saves it to the goal's conversation,
 * building on the conversation as the cycle loaded it, but a turn the chat ran is already in
 * the chat's conversation, which the chat saves itself.
 */
type CycleTranscript = { readonly saveOnto: Conversation | null } | "chat-owned";

function settleInterruptedCycle(
  goal: GoalRecord,
  runId: string,
  messages: readonly ChatMessage[],
  transcript: CycleTranscript,
) {
  return Effect.gen(function* () {
    const goals = yield* GoalStoreTag;
    const runs = yield* RunStoreTag;
    if (transcript !== "chat-owned" && messages.length > 0) {
      yield* saveGoalTranscript(goal, transcript.saveOnto, messages);
    }
    const current = yield* goals.get(goal.goalId);
    const cycle = current?.cycle;
    if (current === undefined || cycle?.runId !== runId) {
      return;
    }
    const run = yield* runs.get(runId);
    yield* writeGoal(
      current,
      settleCycle(
        { ...current, cycle: { ...cycle, stopAfter: cycle.stopAfter ?? "pause" } },
        { run: { kind: "interrupted", spend: run === undefined ? NO_REPAIR : runSpend(run) } },
      ),
      "pause where the user stopped it",
    );
  });
}

function withoutAttendance(goal: GoalRecord): GoalRecordInput {
  const { attendedBy: _attendedBy, ...rest } = asInput(goal);
  return rest;
}

/**
 * Claim the next turn of a goal the chat runs itself, as a cycle: budget-checked, counted, and
 * marked in flight. Returns the prompt and run options for an ordinary chat turn, so the turn
 * renders like any other; undefined when the goal is no longer active here.
 */
export function claimChatGoalTurn(goalId: string) {
  return Effect.gen(function* () {
    const goals = yield* GoalStoreTag;
    const goal = yield* goals.get(goalId);
    if (goal === undefined || goal.state.kind !== "active" || goal.cycle !== undefined) {
      return undefined;
    }
    const claim = yield* claimCycle(goal);
    if (claim === undefined) {
      return undefined;
    }
    return {
      goal: claim.goal,
      runId: claim.runId,
      prompt: goalCyclePrompt(claim.goal, claim.runId, { attended: true }),
      runOptions: { runId: claim.runId, startedBy: "goal" } satisfies Partial<AgentRunnerOptions>,
    };
  });
}

/**
 * Settle a goal turn the chat ran, from how it ended, and return the goal as it now stands. An
 * interrupted turn pauses the goal. The chat keeps its own conversation, so nothing is saved here.
 */
export function settleChatGoalTurn(
  goal: GoalRecord,
  runId: string,
  outcome: RunOutcome<AgentResponse>,
) {
  return Effect.gen(function* () {
    const goals = yield* GoalStoreTag;
    if (outcome.kind === "finished" && outcome.response.interrupted === true) {
      yield* settleInterruptedCycle(goal, runId, [], "chat-owned");
    } else {
      yield* settleRunOutcome(goal, runId, outcome, "chat-owned");
    }
    return yield* goals.get(goal.goalId);
  });
}

/**
 * A goal whose attending chat died without handing it off. An active goal is paused, so the
 * daemon never runs it with authority the user did not grant for running unattended; a goal
 * in any other state only loses the stale mark.
 */
function releaseAbandonedAttendance(goal: GoalRecord) {
  const released = withoutAttendance(goal);
  if (goal.state.kind !== "active") {
    return writeGoal(goal, released, "forget a chat that stopped attending it");
  }
  return writeGoal(
    goal,
    goal.cycle === undefined
      ? { ...released, state: { kind: "paused" } }
      : { ...released, state: { kind: "stopping" }, cycle: { ...goal.cycle, stopAfter: "pause" } },
    "pause a goal whose chat stopped",
  );
}

function settleRunOutcome(
  goal: GoalRecord,
  runId: string,
  outcome: RunOutcome<AgentResponse>,
  transcript: CycleTranscript,
) {
  return Effect.gen(function* () {
    if (outcome.kind === "parked") {
      if (transcript !== "chat-owned" && outcome.park.messages !== undefined) {
        yield* saveGoalTranscript(goal, transcript.saveOnto, outcome.park.messages);
      }
      yield* settleParkedCycle(goal.goalId, runId);
      return;
    }
    if (outcome.kind === "failed") {
      yield* finishCycle(goal.goalId, runId, []);
      return;
    }
    const messages = outcome.response.messages ?? [];
    if (transcript !== "chat-owned") {
      yield* saveGoalTranscript(goal, transcript.saveOnto, messages);
    }
    yield* finishCycle(goal.goalId, runId, cycleMessages(messages, runId));
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
 * Whether a spend cap holds the goal's next cycle back. The goal stays active and its next
 * cycle starts on the first tick after the cap clears (a new day or month, or a raised
 * cap); the notify targets hear about it once per cap and window.
 */
function spendBlocksNextCycle(goal: GoalRecord) {
  return Effect.gen(function* () {
    const appConfig = yield* (yield* AgentConfigServiceTag).appConfig;
    const blocked = yield* nextCycleBlockedBySpend({
      agentId: goal.agentId,
      origin: { source: "goal", name: goalName(goal) },
      appConfig,
    });
    return blocked !== undefined;
  });
}

/**
 * One daemon tick: settle cycles whose runs have moved on and start due cycles. A started
 * cycle runs on its own fiber so one long cycle does not hold up triggers, workflows, or
 * other goals; the fibers are returned for callers that want to wait on them. With `startNew`
 * false (the daemon is paused) cycles already running are still settled, but none starts.
 */
export function runDueGoals(options: { readonly startNew?: boolean } = {}) {
  return Effect.gen(function* () {
    const goals = yield* GoalStoreTag;
    const runs = yield* RunStoreTag;
    const logger = yield* LoggerServiceTag;
    const started: Fiber.RuntimeFiber<void, never>[] = [];
    const candidates = yield* goals.list({ states: CLAIMED_GOAL_STATES });
    for (const goal of candidates) {
      yield* Effect.gen(function* () {
        if (goal.attendedBy !== undefined) {
          if (localOwnerStatus(goal.attendedBy) === "gone") {
            yield* releaseAbandonedAttendance(goal);
          }
          return;
        }
        const cycle = goal.cycle;
        if (cycle === undefined) {
          if (goal.state.kind !== "active" || options.startNew === false) {
            return;
          }
          if (yield* spendBlocksNextCycle(goal)) {
            return;
          }
          const claim = yield* claimCycle(goal);
          if (claim !== undefined) {
            started.push(
              yield* inFlight(claim.runId, runCycle(claim.goal, claim.agent, claim.runId)).pipe(
                Effect.asVoid,
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
        const cycleOwner = claimOwnerStatus(cycle.owner, cycle.runId);
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
          const runOwner = claimOwnerStatus(run.state.owner ?? cycle.owner, cycle.runId);
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
 * Answer a parked run that is a goal's cycle, and settle the cycle with the result: finished,
 * parked again on another approval, or failed. The goal is active again while the answered run
 * works, so a pause or cancel in that window is recorded on the cycle instead of being lost.
 * Undefined when no goal owns the run; `resumeOwnedRun` is what answer surfaces call.
 */
export function resumeGoalRun(options: ResumeRunOptions) {
  return Effect.gen(function* () {
    const goals = yield* GoalStoreTag;
    const candidates = yield* goals.list({
      states: ["active", "awaiting-input", "paused", "stopping"],
    });
    const goal = candidates.find((candidate) => candidate.cycle?.runId === options.runId);
    if (goal === undefined) {
      return undefined;
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
    // The resuming process takes the cycle over, so a daemon tick while it works sees a live
    // owner instead of an abandoned cycle and leaves its settlement to this process.
    const working = yield* goals
      .compareAndSet(goal.goalId, goal.version, {
        ...asInput(goal),
        state: { kind: "active" },
        ...(goal.cycle !== undefined
          ? { cycle: { ...goal.cycle, owner: currentProcessOwner() } }
          : {}),
      })
      .pipe(Effect.either);
    if (working._tag === "Left") {
      return {
        kind: "blocked",
        reason: `Goal ${goal.goalId} changed while answering; check /goal list and retry.`,
      } as const;
    }
    const prior = yield* loadConversationOrNull(goal.agentId, goal.conversationId);
    const outcome = yield* inFlight(
      options.runId,
      Effect.gen(function* () {
        const settled = yield* runToOutcome(resumeRun({ ...options, startedBy: "goal" }));
        yield* settleRunOutcome(working.right, options.runId, settled, { saveOnto: prior });
        return settled;
      }),
    );
    return { kind: "resumed", owner: { goalId: goal.goalId }, outcome } as const;
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
