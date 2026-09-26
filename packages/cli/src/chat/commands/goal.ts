/**
 * @fileoverview Goals in chat.
 *
 * A goal accepted in a conversation runs in it: its cycles stream in front of the user, its
 * approvals are asked inline under the chat's own safe or yolo mode, and Esc stops it where it
 * is. Only when the user leaves the chat is it offered to the daemon, and then with the
 * authority the user picks for running unattended. The planning and controls themselves live
 * in `@jazz/adapters/goals/goal-actions`, shared with `jazz goal` and the daemon.
 */

import { holdAttendance, runAttendedCycles } from "@jazz/adapters/daemon/goal-worker";
import {
  activateGoal,
  answerGoal,
  controlGoal,
  getOwnedGoal,
  listOwnedGoals,
  pendingGoalInput,
  proposedGoals,
  proposeGoal,
  type GoalAnswer,
} from "@jazz/adapters/goals/goal-actions";
import { makeFileGoalStoreLayer } from "@jazz/adapters/storage/goal-store";
import { makeFileRunStoreLayer } from "@jazz/adapters/storage/run-store";
import type { GoalRecord } from "@jazz/core/agent/goal/goal-record";
import { WAITING_ON_USER_GOAL_STATES } from "@jazz/core/agent/goal/goal-state";
import { FileSystemContextServiceTag } from "@jazz/core/interfaces/fs";
import { TerminalServiceTag } from "@jazz/core/interfaces/terminal";
import type { ApprovalPolicyLevel, AutoApprovePolicy } from "@jazz/core/types/tools";
import { currentProcessOwner } from "@jazz/core/utils/process";
import { Effect } from "effect";
import { describeGoalStart, ensureDaemonRunning } from "@/cli/commands/daemon";
import { describeGoal, describeGoalNow, describePlan, goalHandle } from "@/cli/goals/describe-goal";
import { store } from "@/cli/ui/store";
import type { CommandContext } from "./types";

/** The chat's approval mode, read live so a Shift+Tab switch applies to a running cycle. */
export type ChatApprovalMode = () => AutoApprovePolicy | undefined;

/**
 * Goals this chat was running when they paused: the user stopped them, or a control from
 * elsewhere did. Leaving the chat offers each one still paused to the daemon.
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

const goalLayers = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(makeFileGoalStoreLayer()), Effect.provide(makeFileRunStoreLayer()));

/** Say where the goal was left and what the user can do about it. */
function reportGoal(goal: GoalRecord) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const handle = goalHandle(goal);
    if (goal.state.kind === "completed") {
      yield* terminal.success(`Goal ${handle} completed: ${goal.state.summary}`);
      return;
    }
    if (goal.state.kind === "paused") {
      pausedHere.add(goal.goalId);
      yield* terminal.info(
        `Goal ${handle} paused. /goal resume ${handle} continues it here; leaving this chat asks whether Jazz should finish it in the background.`,
      );
      return;
    }
    yield* terminal.log(yield* describeGoalNow(goal, "chat"));
  });
}

/**
 * Run the goal's cycles here until it stops being active, after `first` (answering what it
 * waits on, for one). The chat is busy meanwhile, so what the user types queues for after.
 */
function attendInChat<E = never, R = never>(
  goal: GoalRecord,
  mode: ChatApprovalMode,
  first: Effect.Effect<{ readonly refused?: string }, E, R> = Effect.succeed({}),
) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    pausedHere.delete(goal.goalId);
    store.setChatBusy(true);
    const attended = yield* holdAttendance(
      goal.goalId,
      Effect.gen(function* () {
        const before = yield* first;
        if (before.refused !== undefined) {
          return { refused: before.refused };
        }
        const left = yield* runAttendedCycles(goal.goalId, {
          autoApprovePolicy: mode,
          onCycle: (cycleGoal) =>
            terminal.info(
              `Goal ${goalHandle(cycleGoal)} · cycle ${String(cycleGoal.usage.cycles)} of ${String(cycleGoal.budget.maxCycles)} (Esc stops it)`,
            ),
        });
        return { left };
      }),
    ).pipe(Effect.ensuring(Effect.sync(() => store.setChatBusy(false))));
    if (attended.kind === "attended-elsewhere") {
      yield* terminal.warn(
        `Goal ${goalHandle(goal)} is running in another chat; follow it there, or stop it with /goal pause ${goalHandle(goal)}.`,
      );
      return;
    }
    if ("refused" in attended.value) {
      yield* terminal.warn(attended.value.refused);
      return;
    }
    if (attended.value.left !== undefined) {
      yield* reportGoal(attended.value.left);
    }
  });
}

/**
 * Offer to cancel the goal already under way in this conversation so another can start.
 * True once it is out of the way; a goal whose cycle is still running elsewhere stops after
 * that cycle, and the user is told to try again then.
 */
function replaceBlockingGoal(blocking: GoalRecord, replacement: string) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const handle = goalHandle(blocking);
    const replace = yield* terminal.confirm(
      `This conversation is already working on goal ${handle}. Cancel it and start ${replacement} instead?`,
      false,
    );
    if (replace !== true) {
      yield* terminal.info(
        `Kept goal ${handle}. Finish or cancel it first (/goal cancel ${handle}), then start the new one.`,
      );
      return false;
    }
    const canceled = yield* controlGoal(blocking.goalId, "cancel");
    if (canceled.kind === "refused") {
      yield* terminal.warn(canceled.reason);
      return false;
    }
    if (canceled.goal.state.kind !== "canceled") {
      yield* terminal.info(
        `Goal ${handle} stops once its running cycle ends; start the new one after that.`,
      );
      return false;
    }
    return true;
  });
}

/** Accept a stored proposal and run it here, offering to replace a goal already under way. */
function acceptHere(goal: GoalRecord, mode: ChatApprovalMode) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const accept = controlGoal(goal.goalId, "accept", { attendedBy: currentProcessOwner() });
    let outcome = yield* accept;
    if (
      outcome.kind === "refused" &&
      outcome.cause === "busy" &&
      (yield* replaceBlockingGoal(outcome.blocking, goalHandle(goal)))
    ) {
      outcome = yield* accept;
    }
    if (outcome.kind === "refused") {
      if (outcome.cause !== "busy") {
        yield* terminal.warn(outcome.reason);
      }
      return;
    }
    yield* attendInChat(outcome.goal, mode);
  });
}

/**
 * After a chat turn, ask about each goal the agent proposed in it: show the plan and run it
 * here if the user accepts. Declining cancels the proposal. This is the only way a proposed
 * goal starts from chat, whatever the approval mode.
 */
export function offerProposedGoals(conversationId: string, mode: ChatApprovalMode) {
  return goalLayers(
    Effect.gen(function* () {
      const terminal = yield* TerminalServiceTag;
      for (const goal of yield* proposedGoals(conversationId)) {
        yield* terminal.log(`\nGoal proposal: ${goalHandle(goal)}\n`);
        yield* terminal.log(describePlan(goal.plan));
        const accepted = yield* terminal.confirm(
          "Start this goal? It runs here, asking you as it goes; Esc stops it.",
          false,
        );
        if (accepted === true) {
          yield* acceptHere(goal, mode);
          continue;
        }
        const declined = yield* controlGoal(goal.goalId, "decline");
        yield* declined.kind === "refused"
          ? terminal.warn(declined.reason)
          : terminal.info("Proposal declined; the goal was not started.");
      }
    }),
  );
}

function draftGoal(context: CommandContext, request: string, mode: ChatApprovalMode) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const proposal = yield* proposeGoal({ agent: context.agent, request, inspect: true });
    if (proposal.kind === "failed") {
      yield* terminal.warn(proposal.reason);
      yield* terminal.info(
        "Nothing was started. Ask for the work directly in chat, or try `/goal` again with another agent or model.",
      );
      return;
    }
    if (proposal.kind === "questions") {
      yield* terminal.info("Before proposing a goal, Jazz needs to know:");
      for (const question of proposal.questions) {
        yield* terminal.log(`  • ${question}`);
      }
      yield* terminal.info("Answer them in a new `/goal` request.");
      return;
    }
    yield* terminal.log(`\nGoal proposal: ${proposal.name}\n`);
    yield* terminal.log(describePlan(proposal.plan));
    const accepted = yield* terminal.confirm(
      "Start this goal? It runs here, asking you as it goes; Esc stops it.",
      false,
    );
    if (accepted !== true) {
      yield* terminal.info("Proposal declined; no goal was started.");
      return;
    }
    const fileSystemContext = yield* FileSystemContextServiceTag;
    const workingDirectory = yield* fileSystemContext.getCwd({
      agentId: context.agent.id,
      conversationId: context.conversationId,
    });
    const activate = activateGoal({
      agent: context.agent,
      workingDirectory,
      request,
      name: proposal.name,
      plan: proposal.plan,
      spend: proposal.spend,
      sourceConversationId: context.conversationId,
      attendedBy: currentProcessOwner(),
    });
    let activation = yield* activate;
    if (
      activation.kind === "refused" &&
      "blocking" in activation &&
      (yield* replaceBlockingGoal(activation.blocking, proposal.name))
    ) {
      activation = yield* activate;
    }
    if (activation.kind === "refused") {
      if (!("blocking" in activation)) {
        yield* terminal.warn(activation.reason);
      }
      return;
    }
    yield* attendInChat(activation.goal, mode);
  });
}

/** Resolve a typed handle to a goal, warning when there is none. */
function findGoal(handle: string | undefined, usage: string) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    if (handle === undefined) {
      yield* terminal.warn(`Usage: ${usage}`);
      return undefined;
    }
    const goal = yield* getOwnedGoal(handle);
    if (goal === undefined) {
      yield* terminal.warn(
        `No goal named "${handle}". /goal list shows this conversation's goals.`,
      );
    }
    return goal;
  });
}

function answerHere(
  handle: string | undefined,
  answer: (goal: GoalRecord) => GoalAnswer,
  usage: string,
  mode: ChatApprovalMode,
) {
  return Effect.gen(function* () {
    const goal = yield* findGoal(handle, usage);
    if (goal === undefined) {
      return;
    }
    yield* attendInChat(
      goal,
      mode,
      Effect.map(answerGoal(goal.goalId, answer(goal)), (answered) =>
        answered.kind === "refused" ? { refused: answered.reason } : {},
      ),
    );
  });
}

function resumeHere(handle: string | undefined, guidance: string, mode: ChatApprovalMode) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const goal = yield* findGoal(handle, "/goal resume <goal> [note]");
    if (goal === undefined) {
      return;
    }
    const outcome = yield* controlGoal(goal.goalId, "resume", {
      guidance,
      attendedBy: currentProcessOwner(),
    });
    if (outcome.kind === "refused") {
      yield* terminal.warn(outcome.reason);
      return;
    }
    if (outcome.note !== undefined) {
      yield* terminal.info(outcome.note);
    }
    if (outcome.goal.state.kind === "active") {
      yield* attendInChat(outcome.goal, mode);
      return;
    }
    yield* terminal.log(yield* describeGoalNow(outcome.goal, "chat"));
  });
}

function stopGoal(control: "pause" | "cancel", handle: string | undefined) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const goal = yield* findGoal(handle, `/goal ${control} <goal>`);
    if (goal === undefined) {
      return;
    }
    const outcome = yield* controlGoal(goal.goalId, control);
    if (outcome.kind === "refused") {
      yield* terminal.warn(outcome.reason);
      return;
    }
    pausedHere.delete(goal.goalId);
    if (outcome.note !== undefined) {
      yield* terminal.info(outcome.note);
    }
    yield* terminal.log(yield* describeGoalNow(outcome.goal, "chat"));
  });
}

const HELP = [
  "/goal <objective>            Plan a longer objective; accepted, it runs here",
  "/goal list                   This conversation's goals and what each needs",
  "/goal accept <goal>          Start a proposed goal here",
  "/goal decline <goal>         Drop a proposed goal",
  "/goal approve <goal>         Allow the step it is waiting on, and carry on here",
  "/goal reject <goal> [why]    Refuse that step, and carry on here",
  "/goal answer <goal> <text>   Answer its question, and carry on here",
  "/goal resume <goal> [note]   Continue a stopped goal here; the note steers it",
  "/goal pause <goal>           Stop after the running cycle",
  "/goal cancel <goal>          Cancel it for good",
  "",
  "While a goal runs, Esc stops it. Leaving the chat asks whether Jazz finishes paused goals in the background.",
];

export function handleGoalCommand(context: CommandContext, args: readonly string[]) {
  const [command, ...rest] = args;
  const [handle] = rest;
  const note = rest.slice(1).join(" ").trim();
  const mode: ChatApprovalMode = context.currentAutoApprovePolicy ?? (() => undefined);
  const done = <E, R>(effect: Effect.Effect<unknown, E, R>) =>
    goalLayers(effect).pipe(Effect.as({ shouldContinue: true }));

  switch (command) {
    case undefined:
    case "help":
      return done(
        Effect.flatMap(TerminalServiceTag, (terminal) =>
          Effect.forEach(HELP, (line) => terminal.log(line)),
        ),
      );
    case "list":
      return done(
        Effect.gen(function* () {
          const terminal = yield* TerminalServiceTag;
          const goals = yield* listOwnedGoals({ sourceConversationId: context.conversationId });
          if (goals.length === 0) {
            yield* terminal.info(
              "No goals in this conversation. Start one with /goal <objective>.",
            );
          }
          for (const goal of goals) {
            yield* terminal.log(yield* describeGoalNow(goal, "chat"));
          }
        }),
      );
    case "accept":
      return done(
        Effect.gen(function* () {
          const terminal = yield* TerminalServiceTag;
          const goal = yield* findGoal(handle, "/goal accept <goal>");
          if (goal === undefined) {
            return;
          }
          if (goal.state.kind !== "proposed") {
            yield* terminal.log(describeGoal(goal, "chat", yield* pendingGoalInput(goal)));
            return;
          }
          yield* acceptHere(goal, mode);
        }),
      );
    case "decline":
      return done(
        Effect.gen(function* () {
          const terminal = yield* TerminalServiceTag;
          const goal = yield* findGoal(handle, "/goal decline <goal>");
          if (goal === undefined) {
            return;
          }
          const outcome = yield* controlGoal(goal.goalId, "decline");
          yield* outcome.kind === "refused"
            ? terminal.warn(outcome.reason)
            : terminal.success(`Goal ${goalHandle(goal)} declined.`);
        }),
      );
    case "approve":
      return done(answerHere(handle, () => ({ kind: "approve" }), "/goal approve <goal>", mode));
    case "reject":
      return done(
        answerHere(
          handle,
          () => ({ kind: "reject", ...(note.length > 0 ? { note } : {}) }),
          "/goal reject <goal> [why]",
          mode,
        ),
      );
    case "answer":
      if (note.length === 0) {
        return done(
          Effect.flatMap(TerminalServiceTag, (terminal) =>
            terminal.warn("Usage: /goal answer <goal> <your answer>"),
          ),
        );
      }
      return done(
        answerHere(
          handle,
          () => ({ kind: "answer", response: note }),
          "/goal answer <goal> <your answer>",
          mode,
        ),
      );
    case "resume":
      return done(resumeHere(handle, note, mode));
    case "pause":
    case "cancel":
      return done(stopGoal(command, handle));
  }
  const request = command === "draft" ? rest.join(" ").trim() : args.join(" ").trim();
  if (request.length === 0) {
    return done(
      Effect.flatMap(TerminalServiceTag, (terminal) =>
        terminal.warn("Give Jazz an objective to plan as a goal."),
      ),
    );
  }
  return done(draftGoal(context, request, mode));
}

/**
 * As the user leaves the chat, offer each goal it paused to the daemon, with the authority the
 * user picks for running unattended. Whatever needs more than that waits for them, and the
 * wizard lists the conversation as waiting.
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
          `Goal ${handle} is paused. Should Jazz keep working on it in the background, and what may it do without asking?`,
          { choices: HANDOFF_CHOICES, default: "low-risk" },
        );
        if (choice === undefined || choice === "stay-paused") {
          yield* terminal.info(`Goal ${handle} stays paused; /goal resume ${handle} continues it.`);
          continue;
        }
        const outcome = yield* controlGoal(goal.goalId, "resume", { approvalPolicy: choice });
        if (outcome.kind === "refused") {
          yield* terminal.warn(outcome.reason);
          continue;
        }
        yield* terminal.success(describeGoalStart(handle, yield* ensureDaemonRunning()));
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
