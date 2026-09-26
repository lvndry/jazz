/**
 * @fileoverview `jazz goal`: draft, start, inspect, and control goals without a chat session.
 *
 * The same actions as the chat `/goal` command, for scripts and schedulers. Nothing here
 * runs a cycle: an active goal advances while `jazz daemon` is running. With `--json`, every
 * subcommand prints one JSON envelope on stdout. Exit codes: 0 done, 1 refused or failed,
 * 2 the request needs answers before a plan can be drafted.
 */

import { makeFileGoalStoreLayer } from "@jazz/adapters/storage/goal-store";
import { makeFileRunStoreLayer } from "@jazz/adapters/storage/run-store";
import { getAgentByIdentifier } from "@jazz/core/agent/agent-service";
import type { GoalControl } from "@jazz/core/agent/goal/goal-controls";
import { getGoalOwnerInstanceId } from "@jazz/core/agent/goal/goal-owner";
import type { GoalBudget } from "@jazz/core/agent/goal/goal-record";
import { GoalStoreTag } from "@jazz/core/interfaces/goal-store";
import { Effect } from "effect";
import { describeGoalStart, ensureDaemonRunning } from "@/cli/commands/daemon";
import {
  activateGoal,
  applyGoalControl,
  decideProposedGoal,
  describeGoal,
  describePlan,
  proposeGoal,
  type GoalProposal,
} from "@/cli/goals/goal-actions";

function emit(json: boolean, envelope: Record<string, unknown>, text: string): void {
  process.stdout.write(json ? `${JSON.stringify(envelope)}\n` : `${text}\n`);
}

function fail(json: boolean, error: string, exitCode = 1): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: false, error })}\n`);
  } else {
    process.stderr.write(`${error}\n`);
  }
  process.exitCode = exitCode;
}

function reportProposal(json: boolean, proposal: Exclude<GoalProposal, { kind: "failed" }>): void {
  if (proposal.kind === "questions") {
    emit(
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
  emit(
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
      fail(options.json, proposal.reason);
      return;
    }
    reportProposal(options.json, proposal);
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => fail(options.json, error instanceof Error ? error.message : String(error))),
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
      fail(options.json, proposal.reason);
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
      fail(options.json, activation.reason);
      return;
    }
    const daemon = yield* ensureDaemonRunning();
    emit(
      options.json,
      { ok: true, kind: "started", goal: activation.goal, daemon: daemon.kind },
      `${describePlan(proposal.plan)}\n\n${describeGoalStart(activation.goal.goalId, daemon)}`,
    );
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => fail(options.json, error instanceof Error ? error.message : String(error))),
    ),
    Effect.provide(makeFileGoalStoreLayer()),
  );
}

export function listGoalsCommand(options: { readonly json: boolean }) {
  return Effect.gen(function* () {
    const store = yield* GoalStoreTag;
    const goals = yield* store.list({ ownerInstanceId: getGoalOwnerInstanceId() });
    emit(
      options.json,
      { ok: true, goals },
      goals.length === 0 ? "No goals." : goals.flatMap((goal) => describeGoal(goal)).join("\n"),
    );
  }).pipe(Effect.provide(makeFileGoalStoreLayer()));
}

export function showGoalCommand(options: { readonly id: string; readonly json: boolean }) {
  return Effect.gen(function* () {
    const store = yield* GoalStoreTag;
    const goal = yield* store.get(options.id);
    if (goal === undefined || goal.ownerInstanceId !== getGoalOwnerInstanceId()) {
      fail(options.json, `No goal with id "${options.id}".`);
      return;
    }
    emit(
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
    const outcome = yield* decideProposedGoal(options.id, options.accept);
    if (outcome.kind === "refused") {
      fail(options.json, outcome.reason);
      return;
    }
    if (!options.accept) {
      emit(options.json, { ok: true, goal: outcome.goal }, `Goal ${options.id} declined.`);
      return;
    }
    const daemon = yield* ensureDaemonRunning();
    emit(
      options.json,
      { ok: true, goal: outcome.goal, daemon: daemon.kind },
      describeGoalStart(options.id, daemon),
    );
  }).pipe(Effect.provide(makeFileGoalStoreLayer()));
}

export function controlGoalCommand(options: {
  readonly control: GoalControl;
  readonly id: string;
  readonly note?: string;
  readonly json: boolean;
}) {
  return Effect.gen(function* () {
    const outcome = yield* applyGoalControl(options.control, options.id, options.note);
    if (outcome.kind === "refused") {
      fail(options.json, outcome.reason);
      return;
    }
    emit(
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
