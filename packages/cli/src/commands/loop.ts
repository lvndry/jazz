/**
 * @fileoverview `jazz loop`: start, inspect, answer, and control loops without a chat session.
 *
 * The same actions as the chat `/loop` command, for scripts and schedulers. Nothing here runs a
 * loop: the daemon does, and starting one launches it when none serves this Jazz home. With
 * `--json`, every subcommand prints one JSON envelope on stdout. Exit codes: 0 done, 1 refused
 * or failed.
 */

import type { RunAnswer } from "@jazz/adapters/daemon/resume-owned-run";
import { isDaemonSupervised } from "@jazz/adapters/daemon/service-install";
import {
  answerLoop,
  controlLoop,
  getOwnedLoop,
  listOwnedLoops,
  startLoop,
} from "@jazz/adapters/loops/loop-actions";
import { makeFileGoalStoreLayer } from "@jazz/adapters/storage/goal-store";
import { makeFileLoopStoreLayer } from "@jazz/adapters/storage/loop-store";
import { makeFileRunStoreLayer } from "@jazz/adapters/storage/run-store";
import type { LoopControl } from "@jazz/core/agent/loop/loop-lifecycle";
import { parseLoopSchedule } from "@jazz/core/agent/loop/loop-lifecycle";
import type { LoopBudget } from "@jazz/core/agent/loop/loop-record";
import { isAgentStartedProcess } from "@jazz/core/utils/env";
import { toError } from "@jazz/core/utils/errors";
import { parseWhen } from "@jazz/core/utils/time";
import { Effect } from "effect";
import { describeDaemonStart, ensureDaemonRunning } from "@/cli/commands/daemon";
import { AGENT_ANSWER_REFUSAL } from "@/cli/commands/run/lifecycle";
import { grantedPolicy } from "@/cli/helpers/approval-policy";
import { emitEnvelope, failEnvelope } from "@/cli/helpers/json-output";
import { describeLoopNow } from "@/cli/loops/describe-loop";

/**
 * Starting or resuming a loop hands it lasting, unattended authority, so a command an agent ran
 * through a tool refuses to: one approved shell call must not become work that repeats forever.
 */
const AGENT_LOOP_REFUSAL =
  "Starting or resuming a loop is your decision; this command was started by a Jazz agent, so it was refused. Run it yourself.";

/** The zone a cron schedule and `--until` clock time are read in when none is given. */
function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Every file store a loop command touches: loops, the runs they start, and goals sharing answers. */
function provideStores<Success, Failure, Requirements>(
  effect: Effect.Effect<Success, Failure, Requirements>,
) {
  return effect.pipe(
    Effect.provide(makeFileLoopStoreLayer()),
    Effect.provide(makeFileRunStoreLayer()),
    Effect.provide(makeFileGoalStoreLayer()),
  );
}

export interface StartLoopOptions {
  readonly agent: string;
  readonly prompt: string;
  /** A duration like `10m` or a cron expression, as typed. */
  readonly every: string;
  readonly timezone?: string;
  readonly name?: string;
  /** When the loop ends on its own, as typed: `2h`, `18:00`, `2026-10-01 09:00`. */
  readonly until?: string;
  readonly approvalPolicy?: string;
  readonly budget: Partial<LoopBudget>;
  readonly json: boolean;
}

export function startLoopCommand(options: StartLoopOptions) {
  return Effect.gen(function* () {
    if (isAgentStartedProcess()) {
      failEnvelope(options.json, AGENT_LOOP_REFUSAL);
      return;
    }
    const granted = grantedPolicy(options.approvalPolicy);
    if (granted.kind === "invalid") {
      failEnvelope(options.json, granted.reason);
      return;
    }
    const timezone = options.timezone ?? localTimezone();
    if (!isValidTimezone(timezone)) {
      failEnvelope(
        options.json,
        `Unknown timezone "${timezone}"; use an IANA name like Europe/Paris.`,
      );
      return;
    }
    const schedule = parseLoopSchedule(options.every, timezone);
    if (!schedule.ok) {
      failEnvelope(options.json, schedule.reason);
      return;
    }
    let expiresAt: string | undefined;
    if (options.until !== undefined) {
      const until = parseWhen(options.until, Date.now(), timezone);
      if (until === null || until <= Date.now()) {
        failEnvelope(
          options.json,
          `--until "${options.until}" is not a future time; use a duration like 2h, a clock time like 18:00, or 2026-10-01 09:00.`,
        );
        return;
      }
      expiresAt = new Date(until).toISOString();
    }
    const outcome = yield* startLoop({
      agentId: options.agent.trim(),
      prompt: options.prompt,
      schedule: schedule.schedule,
      workingDirectory: process.cwd(),
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(granted.policy !== undefined ? { approvalPolicy: granted.policy } : {}),
      budget: { ...options.budget, ...(expiresAt !== undefined ? { expiresAt } : {}) },
    });
    if (outcome.kind === "refused") {
      failEnvelope(options.json, outcome.reason);
      return;
    }
    const daemon = yield* ensureDaemonRunning();
    emitEnvelope(
      options.json,
      {
        ok: true,
        kind: "started",
        loop: outcome.loop,
        daemon: daemon.kind,
        daemonSupervised: isDaemonSupervised(),
      },
      `${yield* describeLoopNow(outcome.loop, "cli")}\n\n${describeDaemonStart(`Loop ${outcome.loop.name}`, daemon)}`,
    );
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => failEnvelope(options.json, toError(error).message)),
    ),
    provideStores,
  );
}

export function listLoopsCommand(options: { readonly json: boolean }) {
  return Effect.gen(function* () {
    const loops = yield* listOwnedLoops();
    const described = yield* Effect.forEach(loops, (loop) => describeLoopNow(loop, "cli"));
    emitEnvelope(
      options.json,
      { ok: true, loops },
      loops.length === 0 ? "No loops." : described.join("\n\n"),
    );
  }).pipe(provideStores);
}

export function showLoopCommand(options: { readonly id: string; readonly json: boolean }) {
  return Effect.gen(function* () {
    const loop = yield* getOwnedLoop(options.id);
    if (loop === undefined) {
      failEnvelope(options.json, `No loop "${options.id}".`);
      return;
    }
    emitEnvelope(
      options.json,
      { ok: true, loop },
      `${yield* describeLoopNow(loop, "cli")}\n  Conversation: ${loop.conversationId}\n  Directory: ${loop.workingDirectory}`,
    );
  }).pipe(provideStores);
}

/** `jazz loop approve|reject|answer`: answer what a loop's run waits on; it finishes here. */
export function answerLoopCommand(options: {
  readonly id: string;
  readonly answer: RunAnswer;
  readonly json: boolean;
}) {
  return Effect.gen(function* () {
    if (options.answer.kind !== "reject" && isAgentStartedProcess()) {
      failEnvelope(options.json, AGENT_ANSWER_REFUSAL);
      return;
    }
    const answered = yield* answerLoop(options.id, options.answer);
    if (answered.kind === "refused") {
      failEnvelope(options.json, answered.reason);
      return;
    }
    emitEnvelope(
      options.json,
      { ok: true, loop: answered.loop },
      `\n${yield* describeLoopNow(answered.loop, "cli")}`,
    );
  }).pipe(provideStores);
}

export function controlLoopCommand(options: {
  readonly control: LoopControl;
  readonly id: string;
  readonly json: boolean;
}) {
  return Effect.gen(function* () {
    if (options.control === "resume" && isAgentStartedProcess()) {
      failEnvelope(options.json, AGENT_LOOP_REFUSAL);
      return;
    }
    const outcome = yield* controlLoop(options.id, options.control);
    if (outcome.kind === "refused") {
      failEnvelope(options.json, outcome.reason);
      return;
    }
    const daemon = options.control === "resume" ? yield* ensureDaemonRunning() : undefined;
    emitEnvelope(
      options.json,
      {
        ok: true,
        loop: outcome.loop,
        ...(outcome.note !== undefined ? { note: outcome.note } : {}),
        ...(daemon !== undefined
          ? { daemon: daemon.kind, daemonSupervised: isDaemonSupervised() }
          : {}),
      },
      [
        daemon !== undefined
          ? describeDaemonStart(`Loop ${outcome.loop.name}`, daemon)
          : `Loop ${outcome.loop.name}: ${outcome.loop.state.kind}.`,
        ...(outcome.note !== undefined ? [outcome.note] : []),
      ].join("\n"),
    );
  }).pipe(provideStores);
}
