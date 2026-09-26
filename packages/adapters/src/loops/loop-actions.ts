/**
 * Starting, listing, and controlling loops, shared by chat, `jazz loop`, and the daemon routes.
 *
 * Only a person starts a loop: nothing here is reachable from an agent's tools, and the CLI
 * refuses to start one from a process an agent started. What a loop may do unattended is the
 * approval policy given here.
 */

import { getGoalOwnerInstanceId } from "@jazz/core/agent/goal/goal-owner";
import { decideLoopControl, type LoopControl } from "@jazz/core/agent/loop/loop-lifecycle";
import {
  newLoop,
  type LoopBudget,
  type LoopRecord,
  type LoopSchedule,
  type LoopStateKind,
} from "@jazz/core/agent/loop/loop-record";
import { AgentServiceTag } from "@jazz/core/interfaces/agent-service";
import { LoopStoreTag } from "@jazz/core/interfaces/loop-store";
import type { ApprovalPolicyLevel } from "@jazz/core/types/tools";
import { Effect } from "effect";

export function getOwnedLoop(loopId: string) {
  return Effect.gen(function* () {
    const loops = yield* LoopStoreTag;
    const loop = yield* loops.get(loopId);
    return loop?.ownerInstanceId === getGoalOwnerInstanceId() ? loop : undefined;
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
    return yield* loops.list({ ...filter, ownerInstanceId: getGoalOwnerInstanceId() });
  });
}

export type StartLoopOutcome =
  | { readonly kind: "started"; readonly loop: LoopRecord }
  | { readonly kind: "refused"; readonly reason: string };

/** Start a loop whose first run is due now. */
export function startLoop(options: {
  readonly agentId: string;
  readonly prompt: string;
  readonly schedule: LoopSchedule;
  readonly workingDirectory: string;
  readonly sourceConversationId?: string;
  readonly approvalPolicy?: ApprovalPolicyLevel;
  readonly budget?: Partial<LoopBudget>;
}) {
  return Effect.gen(function* () {
    const agents = yield* AgentServiceTag;
    const loops = yield* LoopStoreTag;
    const agent = yield* agents.getAgent(options.agentId).pipe(Effect.either);
    if (agent._tag === "Left") {
      const refused: StartLoopOutcome = {
        kind: "refused",
        reason: `No agent "${options.agentId}".`,
      };
      return refused;
    }
    const created = yield* loops
      .create(
        newLoop({
          agentId: agent.right.id,
          prompt: options.prompt,
          schedule: options.schedule,
          workingDirectory: options.workingDirectory,
          firstRunAt: new Date(),
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
  loopId: string,
  control: LoopControl,
  options: { readonly expectedVersion?: number } = {},
) {
  return Effect.gen(function* () {
    const loops = yield* LoopStoreTag;
    const loop = yield* getOwnedLoop(loopId);
    if (loop === undefined) {
      const missing: LoopControlOutcome = {
        kind: "refused",
        cause: "missing",
        reason: `No loop with id "${loopId}".`,
      };
      return missing;
    }
    if (options.expectedVersion !== undefined && loop.version !== options.expectedVersion) {
      const changed: LoopControlOutcome = {
        kind: "refused",
        cause: "changed",
        reason: `Loop ${loopId} changed; refresh and retry.`,
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
            reason: `Could not update loop ${loopId}: ${saved.left.message}`,
          }
        : {
            kind: "applied",
            loop: saved.right,
            ...(decision.note !== undefined ? { note: decision.note } : {}),
          };
    return outcome;
  });
}
