/**
 * Starting, listing, and controlling loops, shared by chat, `jazz loop`, and the daemon routes.
 *
 * Only a person starts a loop: nothing here is reachable from an agent's tools, and the CLI
 * refuses to start one from a process an agent started. What a loop may do unattended is the
 * approval policy given here.
 */

import { getAgentByIdentifier } from "@jazz/core/agent/agent-service";
import {
  decideLoopControl,
  firstRunAt,
  type LoopControl,
} from "@jazz/core/agent/loop/loop-lifecycle";
import { chooseLoopName } from "@jazz/core/agent/loop/loop-names";
import {
  newLoop,
  type LoopBudget,
  type LoopRecord,
  type LoopSchedule,
  type LoopStateKind,
} from "@jazz/core/agent/loop/loop-record";
import { LoopStoreTag } from "@jazz/core/interfaces/loop-store";
import type { ApprovalPolicyLevel } from "@jazz/core/types/tools";
import { findByNameOrIdPrefix } from "@jazz/core/utils/handle";
import { getJazzInstanceId } from "@jazz/core/utils/instance-id";
import { Effect } from "effect";
import { resumeLoopRun } from "@/adapters/loops/loop-worker";
import {
  pendingRunInput,
  runAnswerOutcome,
  type RunAnswer,
} from "@/adapters/runs/resume-owned-run";

/**
 * A loop this installation owns, by its id, its name, or a prefix of its id that names only one
 * loop. Undefined for a missing or foreign loop.
 */
export function getOwnedLoop(handle: string) {
  return Effect.gen(function* () {
    const loops = yield* LoopStoreTag;
    const owner = getJazzInstanceId();
    const exact = yield* loops.get(handle);
    if (exact !== undefined) {
      return exact.ownerInstanceId === owner ? exact : undefined;
    }
    const owned = yield* loops.list({ ownerInstanceId: owner });
    return findByNameOrIdPrefix(owned, handle, (loop) => loop.loopId);
  });
}

export function listOwnedLoops(
  filter: {
    readonly sourceConversationId?: string;
    readonly states?: readonly LoopStateKind[];
  } = {},
) {
  return Effect.gen(function* () {
    const loops = yield* LoopStoreTag;
    return yield* loops.list({ ...filter, ownerInstanceId: getJazzInstanceId() });
  });
}

export type StartLoopOutcome =
  | { readonly kind: "started"; readonly loop: LoopRecord }
  | { readonly kind: "refused"; readonly reason: string };

/** Start a loop: an interval loop runs right away, a cron loop at its first scheduled time. */
export function startLoop(options: {
  /** The agent's id or name. */
  readonly agentId: string;
  /** What to call it; named after the start of its prompt when absent. */
  readonly name?: string;
  readonly prompt: string;
  readonly schedule: LoopSchedule;
  readonly workingDirectory: string;
  readonly sourceConversationId?: string;
  readonly approvalPolicy?: ApprovalPolicyLevel;
  readonly budget?: Partial<LoopBudget>;
}) {
  return Effect.gen(function* () {
    const loops = yield* LoopStoreTag;
    const agent = yield* getAgentByIdentifier(options.agentId).pipe(Effect.either);
    if (agent._tag === "Left") {
      const refused: StartLoopOutcome = {
        kind: "refused",
        reason: `No agent "${options.agentId}".`,
      };
      return refused;
    }
    const firstRun = firstRunAt(options.schedule, new Date());
    if (firstRun === undefined) {
      const refused: StartLoopOutcome = {
        kind: "refused",
        reason: "Its schedule never fires.",
      };
      return refused;
    }
    const name = yield* chooseLoopName({
      prompt: options.prompt,
      ...(options.name !== undefined ? { name: options.name } : {}),
    });
    const created = yield* loops
      .create(
        newLoop({
          agentId: agent.right.id,
          name,
          prompt: options.prompt,
          schedule: options.schedule,
          workingDirectory: options.workingDirectory,
          firstRunAt: firstRun,
          ...(options.sourceConversationId !== undefined
            ? { sourceConversationId: options.sourceConversationId }
            : {}),
          ...(options.approvalPolicy !== undefined
            ? { approvalPolicy: options.approvalPolicy }
            : {}),
          ...(options.budget !== undefined ? { budget: options.budget } : {}),
        }),
      )
      .pipe(Effect.either);
    const outcome: StartLoopOutcome =
      created._tag === "Left"
        ? { kind: "refused", reason: created.left.message }
        : { kind: "started", loop: created.right };
    return outcome;
  });
}

export type LoopControlOutcome =
  | { readonly kind: "applied"; readonly loop: LoopRecord; readonly note?: string }
  | {
      readonly kind: "refused";
      readonly cause: "missing" | "changed" | "refused";
      readonly reason: string;
    };

/**
 * Pause, resume, or cancel a loop this installation owns. `expectedVersion` refuses the control
 * when the loop changed since the caller read it.
 */
export function controlLoop(
  handle: string,
  control: LoopControl,
  options: { readonly expectedVersion?: number } = {},
) {
  return Effect.gen(function* () {
    const loops = yield* LoopStoreTag;
    const loop = yield* getOwnedLoop(handle);
    if (loop === undefined) {
      const missing: LoopControlOutcome = {
        kind: "refused",
        cause: "missing",
        reason: `No loop "${handle}".`,
      };
      return missing;
    }
    if (options.expectedVersion !== undefined && loop.version !== options.expectedVersion) {
      const changed: LoopControlOutcome = {
        kind: "refused",
        cause: "changed",
        reason: `Loop ${loop.name} changed; refresh and retry.`,
      };
      return changed;
    }
    const decision = decideLoopControl(loop, control, new Date());
    if (decision.kind === "refused") {
      const refused: LoopControlOutcome = {
        kind: "refused",
        cause: "refused",
        reason: decision.reason,
      };
      return refused;
    }
    const saved = yield* loops
      .compareAndSet(loop.loopId, loop.version, decision.next)
      .pipe(Effect.either);
    const outcome: LoopControlOutcome =
      saved._tag === "Left"
        ? {
            kind: "refused",
            cause: "refused",
            reason: `Could not update loop ${loop.name}: ${saved.left.message}`,
          }
        : {
            kind: "applied",
            loop: saved.right,
            ...(decision.note !== undefined ? { note: decision.note } : {}),
          };
    return outcome;
  });
}

/** What a loop's run waits on from the user, or undefined when nothing is waiting. */
export function pendingLoopInput(loop: LoopRecord) {
  return loop.run === undefined ? Effect.succeed(undefined) : pendingRunInput(loop.run.runId);
}

/**
 * Answer what a loop's run is waiting on. The rest of the run happens in the calling process and
 * is folded into the loop however it ends.
 */
export function answerLoop(handle: string, answer: RunAnswer) {
  return Effect.gen(function* () {
    const loop = yield* getOwnedLoop(handle);
    if (loop === undefined) {
      return { kind: "refused", reason: `No loop "${handle}".` } as const;
    }
    const pending = yield* pendingLoopInput(loop);
    if (pending === undefined) {
      return { kind: "refused", reason: "It is not waiting for an answer from you." } as const;
    }
    const fitted = runAnswerOutcome(pending, answer);
    if (fitted.kind === "mismatch") {
      return { kind: "refused", reason: fitted.reason } as const;
    }
    const resumed = yield* resumeLoopRun({ runId: pending.runId, outcome: fitted.outcome });
    if (resumed === undefined) {
      return { kind: "refused", reason: "Its waiting run is no longer part of the loop." } as const;
    }
    if (resumed.kind === "blocked") {
      return { kind: "refused", reason: resumed.reason } as const;
    }
    return { kind: "answered", loop: (yield* getOwnedLoop(loop.loopId)) ?? loop } as const;
  });
}

/**
 * Loops that can go no further until the user acts: stopped after failures, out of budget, or
 * with a run waiting on an approval or answer.
 */
export function loopsWaitingOnUser(filter: { readonly sourceConversationId?: string } = {}) {
  return Effect.gen(function* () {
    const loops = yield* listOwnedLoops({
      ...filter,
      states: ["active", "failed", "budget-limited"],
    });
    return yield* Effect.filter(loops, (loop) =>
      loop.state.kind === "active"
        ? Effect.map(pendingLoopInput(loop), (pending) => pending !== undefined)
        : Effect.succeed(true),
    );
  });
}
