/**
 * @fileoverview `jazz goal`: draft, start, inspect, and control goals without a chat session.
 *
 * The same actions as the chat `/goal` command, for scripts and schedulers. Nothing here
 * runs a cycle: an active goal advances while `jazz daemon` is running. With `--json`, every
 * subcommand prints one JSON envelope on stdout. Exit codes: 0 done, 1 refused or failed,
 * 2 the request needs answers before a plan can be drafted.
 */

import {
  activateGoal,
  controlGoal,
  getOwnedGoal,
  listOwnedGoals,
  proposeGoal,
  type GoalProposal,
} from "@jazz/adapters/goals/goal-actions";
import { makeFileGoalStoreLayer } from "@jazz/adapters/storage/goal-store";
import { makeFileRunStoreLayer } from "@jazz/adapters/storage/run-store";
import { getAgentByIdentifier } from "@jazz/core/agent/agent-service";
import type { GoalControl } from "@jazz/core/agent/goal/goal-controls";
import type { GoalBudget } from "@jazz/core/agent/goal/goal-record";
import { toError } from "@jazz/core/utils/storage";
import { Effect } from "effect";
import { describeGoal, describePlan } from "@/cli/goals/describe-goal";
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
}

/** Draft a plan and, with `--yes`, accept it as an active goal for the daemon to run. */
export function startGoalCommand(options: StartGoalOptions) {
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
      request: options.request,
      plan: proposal.plan,
      spend: proposal.spend,
      budget: options.budget,
    });
    if (activation.kind === "refused") {
      failEnvelope(options.json, activation.reason);
      return;
    }
    emitEnvelope(
      options.json,
      { ok: true, kind: "started", goal: activation.goal },
      `${describePlan(proposal.plan)}\n\nGoal ${activation.goal.goalId} started. It advances while \`jazz daemon\` is running.`,
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
    emitEnvelope(
      options.json,
      { ok: true, goals },
      goals.length === 0 ? "No goals." : goals.flatMap((goal) => describeGoal(goal)).join("\n"),
    );
  }).pipe(Effect.provide(makeFileGoalStoreLayer()));
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
      [...describeGoal(goal), "", describePlan(goal.plan)].join("\n"),
    );
  }).pipe(Effect.provide(makeFileGoalStoreLayer()));
}

/** Start (`accept`) or drop (`decline`) a goal the agent proposed. */
export function decideProposedGoalCommand(options: {
  readonly id: string;
  readonly accept: boolean;
  readonly json: boolean;
}) {
  return Effect.gen(function* () {
    const outcome = yield* controlGoal(options.id, options.accept ? "accept" : "decline");
    if (outcome.kind === "refused") {
      failEnvelope(options.json, outcome.reason);
      return;
    }
    emitEnvelope(
      options.json,
      { ok: true, goal: outcome.goal },
      options.accept
        ? `Goal ${options.id} started. It advances while \`jazz daemon\` is running.`
        : `Goal ${options.id} declined.`,
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
