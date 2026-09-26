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
import { FileSystemContextServiceTag } from "@jazz/core/interfaces/fs";
import { TerminalServiceTag } from "@jazz/core/interfaces/terminal";
import {
  APPROVAL_POLICY_LEVELS,
  isApprovalPolicyLevel,
  type ApprovalPolicyLevel,
} from "@jazz/core/types/tools";
import { Effect } from "effect";
import { describeGoalStart, ensureDaemonRunning } from "@/cli/commands/daemon";
import { describeGoal, describePlan } from "@/cli/goals/describe-goal";
import type { CommandContext } from "./types";

const APPROVAL_POLICY_CHOICES: readonly { name: string; value: ApprovalPolicyLevel }[] = [
  {
    name: "Reading and low-risk changes; ask me before anything riskier",
    value: "low-risk",
  },
  { name: "Everything, including commands flagged high-risk", value: "high-risk" },
  { name: "Reading only; ask me before any change", value: "read-only" },
];

/** The authority the user grants a goal as they accept it; undefined when they back out. */
function askApprovalPolicy() {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    return yield* terminal.select<ApprovalPolicyLevel>(
      "What may it do while you are away, without asking you?",
      { choices: APPROVAL_POLICY_CHOICES, default: "low-risk" },
    );
  });
}

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
        "Start this goal? Jazz keeps working on it in the background until it is done.",
        false,
      );
      const approvalPolicy = accepted === true ? yield* askApprovalPolicy() : undefined;
      if (accepted === true && approvalPolicy === undefined) {
        yield* terminal.info(
          `Not started; the proposal stays open. Accept it later with /goal accept ${goal.goalId}.`,
        );
        continue;
      }
      const outcome = yield* controlGoal(
        goal.goalId,
        accepted === true ? "accept" : "decline",
        approvalPolicy !== undefined ? { approvalPolicy } : {},
      );
      if (outcome.kind === "refused") {
        yield* terminal.warn(outcome.reason);
      } else if (accepted === true) {
        const daemon = yield* ensureDaemonRunning();
        yield* terminal.success(
          `${describeGoalStart(goal.goalId, daemon)} Follow it with /goal list.`,
        );
      } else {
        yield* terminal.info("Proposal declined; the goal was not started.");
      }
    }
  }).pipe(Effect.provide(makeFileGoalStoreLayer()), Effect.provide(makeFileRunStoreLayer()));
}

function draftGoal(context: CommandContext, request: string) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const proposal = yield* proposeGoal({
      agent: context.agent,
      request,
      inspect: true,
    });
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
      return;
    }
    yield* terminal.log("\nGoal proposal\n");
    yield* terminal.log(describePlan(proposal.plan));
    const accepted = yield* terminal.confirm(
      "Accept this plan and let Jazz continue toward it?",
      false,
    );
    const approvalPolicy = accepted === true ? yield* askApprovalPolicy() : undefined;
    if (approvalPolicy === undefined) {
      yield* terminal.info("Proposal declined; no goal was activated.");
      return;
    }
    const fileSystemContext = yield* FileSystemContextServiceTag;
    const workingDirectory = yield* fileSystemContext.getCwd({
      agentId: context.agent.id,
      conversationId: context.conversationId,
    });
    const activation = yield* activateGoal({
      agent: context.agent,
      workingDirectory,
      request,
      plan: proposal.plan,
      spend: proposal.spend,
      sourceConversationId: context.conversationId,
      approvalPolicy,
    });
    if (activation.kind === "refused") {
      yield* terminal.warn(activation.reason);
      return;
    }
    const daemon = yield* ensureDaemonRunning();
    yield* terminal.success(describeGoalStart(activation.goal.goalId, daemon));
    yield* terminal.info(
      "Inspect or control it with `/goal list`, `/goal pause`, or `/goal cancel`.",
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
      yield* terminal.log(
        "/goal accept <id> [tier]   Start a proposed goal; tier is what it may do unasked",
      );
      yield* terminal.log("/goal decline <id>         Drop a proposed goal");
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
      const [goalId, tier] = rest;
      if (goalId === undefined) {
        yield* terminal.warn(
          command === "accept"
            ? `Usage: /goal accept <goal-id> [${APPROVAL_POLICY_LEVELS.join("|")}]`
            : "Usage: /goal decline <goal-id>",
        );
        return { shouldContinue: true };
      }
      if (tier !== undefined && (command !== "accept" || !isApprovalPolicyLevel(tier))) {
        yield* terminal.warn(
          `Expected one of ${APPROVAL_POLICY_LEVELS.join(", ")}, got "${tier}".`,
        );
        return { shouldContinue: true };
      }
      const outcome = yield* controlGoal(
        goalId,
        command,
        tier !== undefined ? { approvalPolicy: tier } : {},
      );
      if (outcome.kind === "refused") {
        yield* terminal.warn(outcome.reason);
      } else if (command === "accept") {
        yield* terminal.success(describeGoalStart(goalId, yield* ensureDaemonRunning()));
      } else {
        yield* terminal.success(`Goal ${goalId} declined.`);
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
