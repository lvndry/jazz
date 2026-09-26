/**
 * @fileoverview `jazz goal`: draft, start, inspect, and control goals without a chat session.
 *
 * The same actions as the chat `/goal` command, for scripts and schedulers. Nothing here
 * runs a cycle: the daemon does, and accepting a goal starts one when none serves this Jazz
 * home. With `--json`, every
 * subcommand prints one JSON envelope on stdout. Exit codes: 0 done, 1 refused or failed,
 * 2 the request needs answers before a plan can be drafted.
 */

import {
  activateGoal,
  answerGoal,
  controlGoal,
  getOwnedGoal,
  listOwnedGoals,
  proposeGoal,
  type GoalAnswer,
  type GoalProposal,
} from "@jazz/adapters/goals/goal-actions";
import { makeFileGoalStoreLayer } from "@jazz/adapters/storage/goal-store";
import { makeFileRunStoreLayer } from "@jazz/adapters/storage/run-store";
import { getAgentByIdentifier } from "@jazz/core/agent/agent-service";
import type { GoalControl } from "@jazz/core/agent/goal/goal-controls";
import type { GoalBudget } from "@jazz/core/agent/goal/goal-record";
import {
  APPROVAL_POLICY_LEVELS,
  isApprovalPolicyLevel,
  type ApprovalPolicyLevel,
} from "@jazz/core/types/tools";
import { isAgentStartedProcess } from "@jazz/core/utils/env";
import { toError } from "@jazz/core/utils/storage";
import { Effect } from "effect";
import { describeGoalStart, ensureDaemonRunning } from "@/cli/commands/daemon";
import { AGENT_ANSWER_REFUSAL } from "@/cli/commands/run/lifecycle";
import { describeGoalNow, describePlan } from "@/cli/goals/describe-goal";
import { emitEnvelope, failEnvelope } from "@/cli/helpers/json-output";

function reportProposal(json: boolean, proposal: Exclude<GoalProposal, { kind: "failed" }>): void {
  if (proposal.kind === "questions") {
    emitEnvelope(
      json,
      { ok: true, kind: "questions", questions: proposal.questions },
      [
        "Before proposing a goal, Jazz needs to know:",
        ...proposal.questions.map((question) => `  • ${question}`),
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }
  emitEnvelope(
    json,
    { ok: true, kind: "plan", plan: proposal.plan },
    `Goal proposal\n\n${describePlan(proposal.plan)}`,
  );
}

export interface DraftGoalOptions {
  readonly agent: string;
  readonly request: string;
  readonly inspect: boolean;
  readonly json: boolean;
}

/** Draft a plan (or the questions it needs answered) without creating a goal. */
export function draftGoalCommand(options: DraftGoalOptions) {
  return Effect.gen(function* () {
    const agent = yield* getAgentByIdentifier(options.agent.trim());
    const proposal = yield* proposeGoal({
      agent,
      request: options.request,
      inspect: options.inspect,
    });
    if (proposal.kind === "failed") {
      failEnvelope(options.json, proposal.reason);
      return;
    }
    reportProposal(options.json, proposal);
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => failEnvelope(options.json, toError(error).message)),
    ),
  );
}

export interface StartGoalOptions extends DraftGoalOptions {
  /** Accept the drafted plan without a prompt; without it the plan is only shown. */
  readonly yes: boolean;
  readonly budget: Partial<GoalBudget>;
  /** The authority granted with the acceptance, as typed on the command line. */
  readonly approvalPolicy?: string;
}

/**
 * The approval policy a command grants, or a refusal for an unknown tier: a typo must not
 * leave an unattended goal with a tier nobody asked for.
 */
function grantedPolicy(
  value: string | undefined,
):
  | { readonly kind: "granted"; readonly policy?: ApprovalPolicyLevel }
  | { readonly kind: "invalid"; readonly reason: string } {
  if (value === undefined) {
    return { kind: "granted" };
  }
  return isApprovalPolicyLevel(value)
    ? { kind: "granted", policy: value }
    : {
        kind: "invalid",
        reason: `Invalid --approval-policy "${value}". Expected ${APPROVAL_POLICY_LEVELS.join(", ")}.`,
      };
}

/** Draft a plan and, with `--yes`, accept it as an active goal for the daemon to run. */
/**
 * Accepting a goal is the user's decision, so a command an agent ran through a tool refuses
 * to accept one: it would turn one approved shell call into lasting, unattended authority.
 */
const AGENT_ACCEPT_REFUSAL =
  "Accepting a goal is your decision; this command was started by a Jazz agent, so it was refused. Run it yourself.";

export function startGoalCommand(options: StartGoalOptions) {
  return Effect.gen(function* () {
    if (options.yes && isAgentStartedProcess()) {
      failEnvelope(options.json, AGENT_ACCEPT_REFUSAL);
      return;
    }
    const granted = grantedPolicy(options.approvalPolicy);
    if (granted.kind === "invalid") {
      failEnvelope(options.json, granted.reason);
      return;
    }
    const agent = yield* getAgentByIdentifier(options.agent.trim());
    const proposal = yield* proposeGoal({
      agent,
      request: options.request,
      inspect: options.inspect,
    });
    if (proposal.kind === "failed") {
      failEnvelope(options.json, proposal.reason);
      return;
    }
    if (proposal.kind === "questions" || !options.yes) {
      reportProposal(options.json, proposal);
      if (proposal.kind === "plan") {
        process.stderr.write("Not started: pass --yes to accept this plan.\n");
        process.exitCode = 1;
      }
      return;
    }
    const activation = yield* activateGoal({
      agent,
      workingDirectory: process.cwd(),
      request: options.request,
      plan: proposal.plan,
      spend: proposal.spend,
      budget: options.budget,
      ...(granted.policy !== undefined ? { approvalPolicy: granted.policy } : {}),
    });
    if (activation.kind === "refused") {
      failEnvelope(options.json, activation.reason);
      return;
    }
    const daemon = yield* ensureDaemonRunning();
    emitEnvelope(
      options.json,
      { ok: true, kind: "started", goal: activation.goal, daemon: daemon.kind },
      `${describePlan(proposal.plan)}\n\n${describeGoalStart(activation.goal.goalId, daemon)}`,
    );
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => failEnvelope(options.json, toError(error).message)),
    ),
    Effect.provide(makeFileGoalStoreLayer()),
  );
}

export function listGoalsCommand(options: { readonly json: boolean }) {
  return Effect.gen(function* () {
    const goals = yield* listOwnedGoals();
    const described = yield* Effect.forEach(goals, (goal) => describeGoalNow(goal, "cli"));
    emitEnvelope(
      options.json,
      { ok: true, goals },
      goals.length === 0 ? "No goals." : described.join("\n\n"),
    );
  }).pipe(Effect.provide(makeFileGoalStoreLayer()), Effect.provide(makeFileRunStoreLayer()));
}

export function showGoalCommand(options: { readonly id: string; readonly json: boolean }) {
  return Effect.gen(function* () {
    const goal = yield* getOwnedGoal(options.id);
    if (goal === undefined) {
      failEnvelope(options.json, `No goal with id "${options.id}".`);
      return;
    }
    emitEnvelope(
      options.json,
      { ok: true, goal },
      `${yield* describeGoalNow(goal, "cli")}\n\n${describePlan(goal.plan)}`,
    );
  }).pipe(Effect.provide(makeFileGoalStoreLayer()), Effect.provide(makeFileRunStoreLayer()));
}

/** Start (`accept`) or drop (`decline`) a goal the agent proposed. */
export function decideProposedGoalCommand(options: {
  readonly id: string;
  readonly accept: boolean;
  readonly json: boolean;
  readonly approvalPolicy?: string;
}) {
  return Effect.gen(function* () {
    if (options.accept && isAgentStartedProcess()) {
      failEnvelope(options.json, AGENT_ACCEPT_REFUSAL);
      return;
    }
    const granted = grantedPolicy(options.approvalPolicy);
    if (granted.kind === "invalid") {
      failEnvelope(options.json, granted.reason);
      return;
    }
    const outcome = yield* controlGoal(
      options.id,
      options.accept ? "accept" : "decline",
      granted.policy !== undefined ? { approvalPolicy: granted.policy } : {},
    );
    if (outcome.kind === "refused") {
      failEnvelope(options.json, outcome.reason);
      return;
    }
    if (!options.accept) {
      emitEnvelope(options.json, { ok: true, goal: outcome.goal }, `Goal ${options.id} declined.`);
      return;
    }
    const daemon = yield* ensureDaemonRunning();
    emitEnvelope(
      options.json,
      { ok: true, goal: outcome.goal, daemon: daemon.kind },
      describeGoalStart(options.id, daemon),
    );
  }).pipe(Effect.provide(makeFileGoalStoreLayer()), Effect.provide(makeFileRunStoreLayer()));
}

/** `jazz goal approve|reject|answer`: answer what a goal waits on; the daemon carries on after. */
export function answerGoalCommand(options: {
  readonly id: string;
  readonly answer: GoalAnswer;
  readonly json: boolean;
}) {
  return Effect.gen(function* () {
    if (options.answer.kind !== "reject" && isAgentStartedProcess()) {
      failEnvelope(options.json, AGENT_ANSWER_REFUSAL);
      return;
    }
    const answered = yield* answerGoal(options.id, options.answer);
    if (answered.kind === "refused") {
      failEnvelope(options.json, answered.reason);
      return;
    }
    emitEnvelope(
      options.json,
      { ok: true, goal: answered.goal },
      yield* describeGoalNow(answered.goal, "cli"),
    );
  }).pipe(Effect.provide(makeFileGoalStoreLayer()), Effect.provide(makeFileRunStoreLayer()));
}

export function controlGoalCommand(options: {
  readonly control: GoalControl;
  readonly id: string;
  readonly note?: string;
  readonly json: boolean;
}) {
  return Effect.gen(function* () {
    const outcome = yield* controlGoal(options.id, options.control, {
      ...(options.note !== undefined ? { guidance: options.note } : {}),
    });
    if (outcome.kind === "refused") {
      failEnvelope(options.json, outcome.reason);
      return;
    }
    emitEnvelope(
      options.json,
      {
        ok: true,
        goal: outcome.goal,
        ...(outcome.note !== undefined ? { note: outcome.note } : {}),
      },
      [
        `Goal ${options.id}: ${outcome.goal.state.kind}.`,
        ...(outcome.note !== undefined ? [outcome.note] : []),
      ].join("\n"),
    );
  }).pipe(Effect.provide(makeFileGoalStoreLayer()), Effect.provide(makeFileRunStoreLayer()));
}
