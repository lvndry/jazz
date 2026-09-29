/**
 * @fileoverview Goals in chat.
 *
 * A goal changes how the chat works, not how it looks: `/goal <objective>` sets it and the chat
 * keeps taking ordinary turns toward it, in the same conversation and with the same rendering,
 * approvals, and questions as any other turn, until the agent reports it done (with evidence
 * from its tool output), it runs out of turns, or the user stops it. The turns themselves run in
 * the chat loop (`chat-service`); this module sets, reports on, and controls the goal. Leaving
 * the chat with a goal unfinished offers to finish it in the background, continuing the same
 * conversation.
 */

import {
  activateGoal,
  answerGoal,
  controlGoal,
  getOwnedGoal,
  listOwnedGoals,
  proposedGoals,
} from "@jazz/adapters/goals/goal-actions";
import type { RunAnswer } from "@jazz/adapters/runs/resume-owned-run";
import { makeFileGoalStoreLayer } from "@jazz/adapters/storage/goal-store";
import { makeFileRunStoreLayer } from "@jazz/adapters/storage/run-store";
import { directGoalPlan, type GoalRecord } from "@jazz/core/agent/goal/goal-record";
import { WAITING_ON_USER_GOAL_STATES } from "@jazz/core/agent/goal/goal-state";
import { FileSystemContextServiceTag } from "@jazz/core/interfaces/fs";
import { TerminalServiceTag } from "@jazz/core/interfaces/terminal";
import type { ApprovalPolicyLevel } from "@jazz/core/types/tools";
import { leadingWords } from "@jazz/core/utils/handle";
import { currentProcessOwner } from "@jazz/core/utils/process";
import { Effect } from "effect";
import { describeDaemonStart, ensureDaemonRunning } from "@/cli/commands/daemon";
import { describeGoalNow, describePlan, goalHandle } from "@/cli/goals/describe-goal";
import { builtinUsage } from "./constants";
import type { CommandContext, CommandResult } from "./types";

/** Words of the objective a goal is named after. */
const NAME_WORDS = 3;

/** States in which a goal still belongs to this chat and `/goal` reports it. */
const OPEN_STATES = [
  "active",
  "awaiting-input",
  "paused",
  "review-required",
  "budget-limited",
] as const;

/**
 * Goals this chat worked on that are paused. Leaving the chat offers each one still paused to
 * the daemon.
 */
const pausedHere = new Set<string>();

type HandoffChoice = ApprovalPolicyLevel | "stay-paused";

const HANDOFF_CHOICES: readonly { name: string; value: HandoffChoice }[] = [
  {
    name: "Yes: reading and low-risk changes; anything riskier waits for me",
    value: "low-risk",
  },
  { name: "Yes: everything, including commands flagged high-risk", value: "high-risk" },
  { name: "Yes: reading only; any change waits for me", value: "read-only" },
  { name: "No: leave it paused", value: "stay-paused" },
];

export const goalLayers = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(makeFileGoalStoreLayer()), Effect.provide(makeFileRunStoreLayer()));

/** This conversation's goal that is not finished, if any. */
function openGoal(conversationId: string) {
  return Effect.map(
    listOwnedGoals({ sourceConversationId: conversationId, states: OPEN_STATES }),
    (goals) => goals[0],
  );
}

/** A named goal, or this conversation's open one when no name is given. */
function goalFor(context: CommandContext, handle: string | undefined) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const goal =
      handle === undefined ? yield* openGoal(context.conversationId) : yield* getOwnedGoal(handle);
    if (goal === undefined) {
      yield* terminal.warn(
        handle === undefined
          ? "This conversation has no goal. Set one with /goal <objective>."
          : `No goal named "${handle}". /goal list shows this conversation's goals.`,
      );
    }
    return goal;
  });
}

/** Cancel the goal already open here so another can start, after asking. */
function replaceOpenGoal(blocking: GoalRecord) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const handle = goalHandle(blocking);
    const replace = yield* terminal.confirm(
      `This conversation is already working on goal ${handle}. Drop it and start the new one?`,
      true,
    );
    if (replace !== true) {
      yield* terminal.info(`Kept goal ${handle}.`);
      return false;
    }
    const canceled = yield* controlGoal(blocking.goalId, "cancel");
    if (canceled.kind === "refused") {
      yield* terminal.warn(canceled.reason);
      return false;
    }
    pausedHere.delete(blocking.goalId);
    return true;
  });
}

/** Set a goal on this conversation; its first turn starts as soon as the command returns. */
function setGoal(context: CommandContext, objective: string) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const existing = yield* openGoal(context.conversationId);
    if (existing !== undefined && !(yield* replaceOpenGoal(existing))) {
      return undefined;
    }
    const fileSystemContext = yield* FileSystemContextServiceTag;
    const workingDirectory = yield* fileSystemContext.getCwd({
      agentId: context.agent.id,
      conversationId: context.conversationId,
    });
    const activation = yield* activateGoal({
      agent: context.agent,
      request: objective,
      plan: directGoalPlan(objective),
      spend: { totalTokens: 0, startedAt: Date.now() },
      name: leadingWords(objective, NAME_WORDS),
      workingDirectory,
      sourceConversationId: context.conversationId,
      conversationId: context.conversationId,
      attendedBy: currentProcessOwner(),
    });
    if (activation.kind === "refused") {
      yield* terminal.warn(activation.reason);
      return undefined;
    }
    yield* terminal.info(`Goal ${goalHandle(activation.goal)} set · Esc pauses`);
    return activation.goal.goalId;
  });
}

/** Accept a goal Jazz proposed and work on it here. */
function acceptHere(goal: GoalRecord) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const accept = controlGoal(goal.goalId, "accept", { attendedBy: currentProcessOwner() });
    let outcome = yield* accept;
    if (
      outcome.kind === "refused" &&
      outcome.cause === "busy" &&
      (yield* replaceOpenGoal(outcome.blocking))
    ) {
      outcome = yield* accept;
    }
    if (outcome.kind === "refused") {
      yield* terminal.warn(outcome.reason);
      return undefined;
    }
    return outcome.goal.goalId;
  });
}

/** Resume a goal here; its next turn starts as soon as the command returns. */
function resumeHere(goal: GoalRecord, guidance: string) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const outcome = yield* controlGoal(goal.goalId, "resume", {
      ...(guidance.length > 0 ? { guidance } : {}),
      attendedBy: currentProcessOwner(),
    });
    if (outcome.kind === "refused") {
      yield* terminal.warn(outcome.reason);
      return undefined;
    }
    pausedHere.delete(goal.goalId);
    if (outcome.note !== undefined) {
      yield* terminal.info(outcome.note);
    }
    if (outcome.goal.state.kind !== "active") {
      yield* terminal.log(yield* describeGoalNow(outcome.goal, "chat"));
      return undefined;
    }
    return outcome.goal.goalId;
  });
}

/** Answer what a goal left waiting in the background; the rest of that run happens here. */
function answerHere(goal: GoalRecord, answer: RunAnswer) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const answered = yield* answerGoal(goal.goalId, answer);
    if (answered.kind === "refused") {
      yield* terminal.warn(answered.reason);
      return undefined;
    }
    if (answered.goal.state.kind !== "active") {
      return yield* settledHere(answered.goal);
    }
    return yield* resumeHere(answered.goal, "");
  });
}

function stopHere(goal: GoalRecord, control: "pause" | "cancel") {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const outcome = yield* controlGoal(goal.goalId, control);
    if (outcome.kind === "refused") {
      yield* terminal.warn(outcome.reason);
      return;
    }
    if (control === "pause") {
      pausedHere.add(goal.goalId);
      yield* terminal.info(`Goal ${goalHandle(goal)} paused; /goal resume continues it.`);
      return;
    }
    pausedHere.delete(goal.goalId);
    yield* terminal.info(`Goal ${goalHandle(goal)} dropped.`);
  });
}

/**
 * Where a goal stands after a turn toward it, told in the chat, and whether the next turn
 * should start. When it stopped for the user (a question, a blocker, its turn cap) the chat asks
 * right here and carries on with the answer; Esc there leaves it paused.
 */
export function settledHere(goal: GoalRecord | undefined) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    if (goal === undefined) {
      return undefined;
    }
    const handle = goalHandle(goal);
    const { state } = goal;
    switch (state.kind) {
      case "active":
        return goal.cycle === undefined ? goal.goalId : undefined;
      case "completed":
        pausedHere.delete(goal.goalId);
        yield* terminal.success(`Goal ${handle} achieved: ${state.summary}`);
        return undefined;
      case "paused":
      case "stopping":
        pausedHere.add(goal.goalId);
        yield* terminal.info(`Goal ${handle} paused; /goal resume continues it.`);
        return undefined;
      case "budget-limited": {
        const more = yield* terminal.confirm(
          `Goal ${handle} used the ${String(goal.budget.maxCycles ?? goal.usage.cycles)} turns it was given. Keep going?`,
          true,
        );
        return more === true ? yield* resumeHere(goal, "") : yield* leavePaused(goal);
      }
      case "review-required": {
        yield* terminal.log(
          state.question !== undefined
            ? `Goal ${handle} asks: ${state.question}`
            : `Goal ${handle} stopped: ${state.reason}`,
        );
        const answer = yield* terminal.ask(
          state.question !== undefined
            ? "Your answer (Esc leaves it paused)"
            : "How should it go on? (Esc leaves it paused)",
          { cancellable: true, simple: true },
        );
        const trimmed = answer?.trim() ?? "";
        return trimmed.length > 0 ? yield* resumeHere(goal, trimmed) : yield* leavePaused(goal);
      }
      default:
        yield* terminal.log(yield* describeGoalNow(goal, "chat"));
        return undefined;
    }
  });
}

function leavePaused(goal: GoalRecord) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    pausedHere.add(goal.goalId);
    yield* terminal.info(`Goal ${goalHandle(goal)} is waiting; /goal resume continues it.`);
    return undefined;
  });
}

/** The line a goal turn opens with, in place of a message from the user. */
export function announceGoalTurn(goal: GoalRecord) {
  return Effect.flatMap(TerminalServiceTag, (terminal) =>
    terminal.info(
      `↻ Goal ${goalHandle(goal)} · turn ${String(goal.usage.cycles)}${goal.budget.maxCycles !== undefined ? ` of ${String(goal.budget.maxCycles)}` : ""}`,
    ),
  );
}

/**
 * On leaving the chat, pause the goal it was working on so the handoff offer can pick it up;
 * nothing runs it once the chat is gone unless the user hands it over.
 */
export function pauseOnExit(goalId: string) {
  return goalLayers(
    Effect.gen(function* () {
      const outcome = yield* controlGoal(goalId, "pause");
      if (outcome.kind === "applied") {
        pausedHere.add(goalId);
      }
    }),
  );
}

export function handleGoalCommand(
  context: CommandContext,
  args: readonly string[],
): Effect.Effect<CommandResult, never, never> {
  const [command, ...rest] = args;
  const [handle] = rest;
  const note = rest.slice(1).join(" ").trim();
  const done = <E, R>(effect: Effect.Effect<unknown, E, R>) =>
    goalLayers(effect).pipe(
      Effect.as<CommandResult>({ shouldContinue: true }),
      Effect.catchAll((error) =>
        Effect.flatMap(TerminalServiceTag, (terminal) =>
          terminal.warn(`Goal command failed: ${String(error)}`),
        ).pipe(Effect.as<CommandResult>({ shouldContinue: true })),
      ),
    ) as Effect.Effect<CommandResult, never, never>;
  const attend = <E, R>(effect: Effect.Effect<string | undefined, E, R>) =>
    goalLayers(effect).pipe(
      Effect.map((goalId): CommandResult =>
        goalId === undefined
          ? { shouldContinue: true }
          : { shouldContinue: true, attendGoal: goalId },
      ),
      Effect.catchAll((error) =>
        Effect.flatMap(TerminalServiceTag, (terminal) =>
          terminal.warn(`Goal command failed: ${String(error)}`),
        ).pipe(Effect.as<CommandResult>({ shouldContinue: true })),
      ),
    ) as Effect.Effect<CommandResult, never, never>;
  const withGoal = <A, E, R>(
    goalHandleArg: string | undefined,
    use: (goal: GoalRecord) => Effect.Effect<A, E, R>,
  ) =>
    Effect.flatMap(goalFor(context, goalHandleArg), (goal) =>
      goal === undefined ? Effect.succeed(undefined) : use(goal),
    );

  switch (command?.toLowerCase()) {
    case undefined:
      return done(
        Effect.gen(function* () {
          const terminal = yield* TerminalServiceTag;
          const goal = yield* openGoal(context.conversationId);
          if (goal === undefined) {
            yield* terminal.log(builtinUsage("goal") ?? "");
            return;
          }
          yield* terminal.log(yield* describeGoalNow(goal, "chat"));
        }),
      );
    case "help":
      return done(
        Effect.flatMap(TerminalServiceTag, (terminal) => terminal.log(builtinUsage("goal") ?? "")),
      );
    case "list":
      return done(
        Effect.gen(function* () {
          const terminal = yield* TerminalServiceTag;
          const goals = yield* listOwnedGoals({ sourceConversationId: context.conversationId });
          if (goals.length === 0) {
            yield* terminal.info("No goals in this conversation. Set one with /goal <objective>.");
          }
          for (const goal of goals) {
            yield* terminal.log(yield* describeGoalNow(goal, "chat"));
          }
        }),
      );
    case "pause":
      return done(withGoal(handle, (goal) => stopHere(goal, "pause")));
    case "clear":
    case "stop":
    case "cancel":
      return done(withGoal(handle, (goal) => stopHere(goal, "cancel")));
    case "resume":
      return attend(
        Effect.gen(function* () {
          const named = handle === undefined ? undefined : yield* getOwnedGoal(handle);
          const goal = named ?? (yield* goalFor(context, undefined));
          if (goal === undefined) {
            return undefined;
          }
          const guidance = (named === undefined ? rest : rest.slice(1)).join(" ").trim();
          return yield* resumeHere(goal, guidance);
        }),
      );
    case "approve":
      return attend(withGoal(handle, (goal) => answerHere(goal, { kind: "approve" })));
    case "reject":
      return attend(
        withGoal(handle, (goal) =>
          answerHere(goal, { kind: "reject", ...(note.length > 0 ? { note } : {}) }),
        ),
      );
    case "answer":
      return attend(
        withGoal(handle, (goal) => answerHere(goal, { kind: "answer", response: note })),
      );
    case "accept":
      return attend(withGoal(handle, acceptHere));
    case "decline":
      return done(
        withGoal(handle, (goal) =>
          Effect.gen(function* () {
            const terminal = yield* TerminalServiceTag;
            const outcome = yield* controlGoal(goal.goalId, "decline");
            yield* outcome.kind === "refused"
              ? terminal.warn(outcome.reason)
              : terminal.info(`Goal ${goalHandle(goal)} declined.`);
          }),
        ),
      );
  }
  return attend(setGoal(context, args.join(" ").trim()));
}

/**
 * After a chat turn, offer each goal the agent proposed in it: show the plan and, if the user
 * accepts, return it so the chat works on it next. Declining cancels the proposal.
 */
export function offerProposedGoals(conversationId: string) {
  return goalLayers(
    Effect.gen(function* () {
      const terminal = yield* TerminalServiceTag;
      for (const goal of yield* proposedGoals(conversationId)) {
        yield* terminal.log(`\nGoal proposal: ${goalHandle(goal)}\n`);
        yield* terminal.log(describePlan(goal.plan));
        const accepted = yield* terminal.confirm("Work on this goal now?", true);
        if (accepted === true) {
          return yield* acceptHere(goal);
        }
        const declined = yield* controlGoal(goal.goalId, "decline");
        yield* declined.kind === "refused"
          ? terminal.warn(declined.reason)
          : terminal.info("Proposal declined; the goal was not started.");
      }
      return undefined;
    }),
  );
}

/**
 * As the user leaves the chat, offer each goal it paused to the daemon, with the authority the
 * user picks for running unattended. It continues the same conversation; whatever needs more
 * than that authority waits for them, and the wizard lists the conversation as waiting.
 */
export function offerGoalHandoffs() {
  return goalLayers(
    Effect.gen(function* () {
      const terminal = yield* TerminalServiceTag;
      for (const goalId of [...pausedHere]) {
        pausedHere.delete(goalId);
        const goal = yield* getOwnedGoal(goalId);
        if (goal?.state.kind !== "paused") {
          continue;
        }
        const handle = goalHandle(goal);
        const choice = yield* terminal.select<HandoffChoice>(
          `Goal ${handle} is not finished. Should Jazz keep working on it in the background, and what may it do without asking?`,
          { choices: HANDOFF_CHOICES, default: "low-risk" },
        );
        if (choice === undefined || choice === "stay-paused") {
          yield* terminal.info(`Goal ${handle} stays paused; /goal resume continues it.`);
          continue;
        }
        const outcome = yield* controlGoal(goal.goalId, "resume", { approvalPolicy: choice });
        if (outcome.kind === "refused") {
          yield* terminal.warn(outcome.reason);
          continue;
        }
        yield* terminal.success(
          describeDaemonStart(`Goal ${handle}`, yield* ensureDaemonRunning()),
        );
        yield* terminal.info(
          "When it needs you, `jazz` lists this conversation as waiting under Resume conversation.",
        );
      }
    }),
  );
}

/** On opening a conversation, show its goals that wait on the user and how to answer them. */
export function announceWaitingGoals(conversationId: string) {
  return goalLayers(
    Effect.gen(function* () {
      const terminal = yield* TerminalServiceTag;
      const waiting = yield* listOwnedGoals({
        sourceConversationId: conversationId,
        states: WAITING_ON_USER_GOAL_STATES,
      });
      for (const goal of waiting) {
        yield* terminal.log(yield* describeGoalNow(goal, "chat"));
      }
    }),
  );
}
