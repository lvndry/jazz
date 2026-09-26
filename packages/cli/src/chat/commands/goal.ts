/**
 * @fileoverview Interactive goal proposals and controls for the chat surface.
 *
 * Broad requests are converted into a tool-free, schema-checked plan proposal. Jazz asks for
 * explicit plan acceptance before activating the durable record; the daemon then owns cycles.
 * The planning and controls themselves live in `@jazz/adapters/goals/goal-actions`, shared with
 * `jazz goal` and the daemon.
 */

import {
  activateGoal,
  controlGoal,
  listOwnedGoals,
  proposedGoals,
  proposeGoal,
} from "@jazz/adapters/goals/goal-actions";
import { makeFileGoalStoreLayer } from "@jazz/adapters/storage/goal-store";
import { makeFileRunStoreLayer } from "@jazz/adapters/storage/run-store";
import type { GoalControl } from "@jazz/core/agent/goal/goal-controls";
import { TerminalServiceTag } from "@jazz/core/interfaces/terminal";
import { Effect } from "effect";
import { describeGoal, describePlan } from "@/cli/goals/describe-goal";
import type { CommandContext } from "./types";

/**
 * After a chat turn, ask about each goal the agent proposed in it: show the plan and start it
 * only if the user accepts. Declining cancels the proposal. This is the only way a proposed
 * goal starts from chat, whatever the approval mode.
 */
export function offerProposedGoals(conversationId: string) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    for (const goal of yield* proposedGoals(conversationId)) {
      yield* terminal.log("\nGoal proposal\n");
      yield* terminal.log(describePlan(goal.plan));
      const accepted = yield* terminal.confirm(
        "Start this goal? Jazz keeps working on it across runs while `jazz daemon` is running.",
        false,
      );
      const outcome = yield* controlGoal(goal.goalId, accepted === true ? "accept" : "decline");
      if (outcome.kind === "refused") {
        yield* terminal.warn(outcome.reason);
      } else if (accepted === true) {
        yield* terminal.success(`Goal ${goal.goalId} started. Follow it with /goal list.`);
      } else {
        yield* terminal.info("Proposal declined; the goal was not started.");
      }
    }
  }).pipe(Effect.provide(makeFileGoalStoreLayer()), Effect.provide(makeFileRunStoreLayer()));
}

function draftGoal(context: CommandContext, request: string) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const inspect = yield* terminal.confirm(
      "Inspect relevant local project files read-only? Matching file contents will be sent to this agent's configured model provider.",
      false,
    );
    const proposal = yield* proposeGoal({
      agent: context.agent,
      request,
      inspect: inspect === true,
    });
    if (proposal.kind === "failed") {
      yield* terminal.warn(`${proposal.reason} The original request was not run.`);
      return;
    }
    if (proposal.kind === "questions") {
      yield* terminal.info("Before proposing a goal, Jazz needs to know:");
      for (const question of proposal.questions) {
        yield* terminal.log(`  • ${question}`);
      }
      return;
    }
    yield* terminal.log("\nGoal proposal\n");
    yield* terminal.log(describePlan(proposal.plan));
    const accepted = yield* terminal.confirm(
      "Accept this plan and let Jazz continue toward it?",
      false,
    );
    if (!accepted) {
      yield* terminal.info("Proposal declined; no goal was activated.");
      return;
    }
    const activation = yield* activateGoal({
      agent: context.agent,
      request,
      plan: proposal.plan,
      spend: proposal.spend,
      sourceConversationId: context.conversationId,
    });
    if (activation.kind === "refused") {
      yield* terminal.warn(activation.reason);
      return;
    }
    yield* terminal.success(
      `Goal ${activation.goal.goalId} accepted. Jazz will continue it while the daemon is running.`,
    );
    yield* terminal.info(
      "Start it with `jazz daemon`; inspect or control it with `/goal list`, `/goal pause`, or `/goal cancel`.",
    );
  }).pipe(Effect.provide(makeFileGoalStoreLayer()));
}

export function handleGoalCommand(context: CommandContext, args: readonly string[]) {
  const [command, ...rest] = args;
  if (command === undefined || command === "help") {
    return Effect.gen(function* () {
      const terminal = yield* TerminalServiceTag;
      yield* terminal.log(
        "/goal <objective>          Draft a plan for a longer objective and accept it",
      );
      yield* terminal.log(
        "/goal list                 Goals from this conversation and their progress",
      );
      yield* terminal.log("/goal pause <id>           Stop after the running cycle settles");
      yield* terminal.log(
        "/goal resume <id> [note]   Resume; the note answers a question or steers the next cycle",
      );
      yield* terminal.log("/goal cancel <id>          Cancel a goal and its parked run");
      return { shouldContinue: true };
    });
  }
  if (command === "list") {
    return Effect.gen(function* () {
      const terminal = yield* TerminalServiceTag;
      const goals = yield* listOwnedGoals({ sourceConversationId: context.conversationId });
      if (goals.length === 0) {
        yield* terminal.info("No goals in this conversation.");
      }
      for (const goal of goals) {
        for (const line of describeGoal(goal)) {
          yield* terminal.log(line);
        }
      }
      return { shouldContinue: true };
    }).pipe(Effect.provide(makeFileGoalStoreLayer()));
  }
  if (command === "accept" || command === "decline") {
    return Effect.gen(function* () {
      const terminal = yield* TerminalServiceTag;
      const goalId = rest[0];
      if (goalId === undefined) {
        yield* terminal.warn(`Usage: /goal ${command} <goal-id>`);
        return { shouldContinue: true };
      }
      const outcome = yield* controlGoal(goalId, command);
      if (outcome.kind === "refused") {
        yield* terminal.warn(outcome.reason);
      } else {
        yield* terminal.success(`Goal ${goalId}: ${outcome.goal.state.kind}.`);
      }
      return { shouldContinue: true };
    }).pipe(Effect.provide(makeFileGoalStoreLayer()), Effect.provide(makeFileRunStoreLayer()));
  }
  if (command === "pause" || command === "resume" || command === "cancel") {
    return runGoalControl(command, rest[0], rest.slice(1).join(" ")).pipe(
      Effect.as({ shouldContinue: true }),
    );
  }
  const request = command === "draft" ? rest.join(" ").trim() : [command, ...rest].join(" ").trim();
  if (request.length === 0) {
    return Effect.gen(function* () {
      const terminal = yield* TerminalServiceTag;
      yield* terminal.warn("Give Jazz an objective to draft as a goal.");
      return { shouldContinue: true };
    });
  }
  return draftGoal(context, request).pipe(Effect.as({ shouldContinue: true }));
}

function runGoalControl(control: GoalControl, goalId: string | undefined, guidance: string) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    if (goalId === undefined) {
      yield* terminal.warn(`Usage: /goal ${control} <goal-id>`);
      return;
    }
    const outcome = yield* controlGoal(goalId, control, { guidance });
    if (outcome.kind === "refused") {
      yield* terminal.warn(outcome.reason);
      return;
    }
    yield* terminal.success(`Goal ${goalId}: ${outcome.goal.state.kind}.`);
    if (outcome.note !== undefined) {
      yield* terminal.info(outcome.note);
    }
  }).pipe(Effect.provide(makeFileGoalStoreLayer()), Effect.provide(makeFileRunStoreLayer()));
}
