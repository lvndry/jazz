import { Context, Effect } from "effect";
import type { GoalId, GoalRecord } from "@/core/agent/goal/goal-record";
import type { GoalStateKind } from "@/core/agent/goal/goal-state";

/**
 * Durable storage for controller-owned goals.
 *
 * A goal is longer-lived than a run and must not be stored in model-authored WorkState.
 * Compare-and-set writes serialize pause, cancellation, plan approval, and continuation
 * claims so two callers cannot advance the same goal version independently.
 */
export interface GoalStore {
  readonly create: (record: Omit<GoalRecord, "version">) => Effect.Effect<GoalRecord, Error>;
  readonly get: (goalId: GoalId) => Effect.Effect<GoalRecord | undefined, never>;
  readonly list: (filter?: {
    readonly ownerInstanceId?: string;
    readonly agentId?: string;
    readonly conversationId?: string;
    readonly sourceConversationId?: string;
    readonly states?: readonly GoalStateKind[];
  }) => Effect.Effect<readonly GoalRecord[], never>;
  readonly compareAndSet: (
    goalId: GoalId,
    expectedVersion: number,
    next: Omit<GoalRecord, "version">,
  ) => Effect.Effect<GoalRecord, Error>;
}

export class GoalStoreTag extends Context.Tag("GoalStore")<GoalStoreTag, GoalStore>() {}
