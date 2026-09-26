/**
 * Durable storage for controller-owned goals.
 *
 * Goals are versioned records (`record-store.ts`): one atomic JSON file per goal, compare-and-set
 * under a per-goal lock. This module adds what is particular to goals: the lifecycle and plan
 * rules an update must follow, and that a conversation has at most one active goal, checked
 * under a store-wide lock. The in-memory store applies the same rules for tests.
 */

import {
  GOAL_ID_PATTERN,
  parseGoalRecord,
  type GoalId,
  type GoalRecord,
} from "@jazz/core/agent/goal/goal-record";
import { isGoalClaimed, isTerminalGoal, transitionGoal } from "@jazz/core/agent/goal/goal-state";
import { GoalStoreTag, type GoalStore } from "@jazz/core/interfaces/goal-store";
import { getGoalsDirectory } from "@jazz/core/utils/paths";
import { toError } from "@jazz/core/utils/storage";
import { Effect, Layer } from "effect";
import {
  FileRecords,
  InMemoryRecords,
  type RecordKind,
  type StampedUpdate,
  type WriteGuard,
} from "./record-store";

function isGoalId(value: string): boolean {
  return GOAL_ID_PATTERN.test(value);
}

function sameGoalPlanDefinition(left: GoalRecord["plan"], right: GoalRecord["plan"]): boolean {
  return (
    left.revision === right.revision &&
    left.objective === right.objective &&
    JSON.stringify(left.successCriteria) === JSON.stringify(right.successCriteria) &&
    JSON.stringify(left.constraints) === JSON.stringify(right.constraints) &&
    JSON.stringify(left.assumptions) === JSON.stringify(right.assumptions) &&
    JSON.stringify(left.feasibility) === JSON.stringify(right.feasibility) &&
    JSON.stringify(left.verification) === JSON.stringify(right.verification) &&
    JSON.stringify(
      left.steps.map(({ id, objective, successCriteria }) => ({ id, objective, successCriteria })),
    ) ===
      JSON.stringify(
        right.steps.map(({ id, objective, successCriteria }) => ({
          id,
          objective,
          successCriteria,
        })),
      )
  );
}

function nextGoalRecord(
  current: GoalRecord,
  next: Omit<GoalRecord, "version">,
  stamped: StampedUpdate,
): GoalRecord {
  if (
    next.ownerInstanceId !== current.ownerInstanceId ||
    next.agentId !== current.agentId ||
    next.sourceConversationId !== current.sourceConversationId ||
    next.conversationId !== current.conversationId ||
    next.request !== current.request
  ) {
    throw new Error("A goal update cannot change its owner, conversation, agent, or root request.");
  }
  if (
    next.usage.cycles < current.usage.cycles ||
    next.usage.totalTokens < current.usage.totalTokens ||
    next.usage.activeDurationMs < current.usage.activeDurationMs ||
    (current.usage.costUSD !== undefined &&
      next.usage.costUSD !== undefined &&
      next.usage.costUSD < current.usage.costUSD) ||
    (!current.usage.costKnown && next.usage.costKnown)
  ) {
    throw new Error("Goal usage cannot move backwards or treat an unknown cost as known.");
  }
  if (isTerminalGoal(current.state)) {
    throw new Error(`Goal "${current.goalId}" is ${current.state.kind} and can no longer change.`);
  }
  if (
    current.cycle !== undefined &&
    next.cycle !== undefined &&
    next.cycle.runId !== current.cycle.runId
  ) {
    throw new Error("An open cycle must be settled before another one is claimed.");
  }
  if (
    current.cycle === undefined &&
    next.cycle !== undefined &&
    (next.usage.cycles !== current.usage.cycles + 1 || next.latestRunId !== next.cycle.runId)
  ) {
    throw new Error("Claiming a cycle must count it and record its run.");
  }
  if (next.plan.revision < current.plan.revision) {
    throw new Error("A goal plan revision cannot move backwards.");
  }
  if (next.plan.revision > current.plan.revision + 1) {
    throw new Error("A goal plan revision must increase by exactly one.");
  }
  if (
    next.plan.revision === current.plan.revision &&
    !sameGoalPlanDefinition(next.plan, current.plan)
  ) {
    throw new Error("Changing a goal plan requires a new revision.");
  }
  const state =
    current.state.kind === next.state.kind ? next.state : transitionGoal(current.state, next.state);
  return { ...next, state, ...stamped };
}

const GOAL_KIND: RecordKind<GoalRecord> = {
  noun: "goal",
  idOf: (record) => record.goalId,
  isId: isGoalId,
  parse: (value) => {
    const parsed = parseGoalRecord(value);
    return parsed.ok ? { ok: true, record: parsed.goal } : parsed;
  },
  nextRecord: nextGoalRecord,
};

function selectRecords(
  records: readonly GoalRecord[],
  filter:
    | {
        readonly ownerInstanceId?: string;
        readonly agentId?: string;
        readonly conversationId?: string;
        readonly sourceConversationId?: string;
        readonly states?: readonly GoalStoreState[];
      }
    | undefined,
): readonly GoalRecord[] {
  const states = filter?.states === undefined ? undefined : new Set(filter.states);
  return records
    .filter(
      (record) =>
        filter?.ownerInstanceId === undefined || record.ownerInstanceId === filter.ownerInstanceId,
    )
    .filter((record) => filter?.agentId === undefined || record.agentId === filter.agentId)
    .filter(
      (record) =>
        filter?.sourceConversationId === undefined ||
        record.sourceConversationId === filter.sourceConversationId,
    )
    .filter(
      (record) =>
        filter?.conversationId === undefined || record.conversationId === filter.conversationId,
    )
    .filter((record) => states === undefined || states.has(record.state.kind))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

type GoalStoreState = GoalRecord["state"]["kind"];

/** Whether writing `next` must check its conversation has no other claimed goal. */
function claimsConversation(next: Omit<GoalRecord, "version">): boolean {
  return next.sourceConversationId !== undefined && isGoalClaimed(next.state);
}

function assertNoActiveConversationConflict(
  next: Omit<GoalRecord, "version">,
  others: readonly GoalRecord[],
): void {
  for (const record of others) {
    if (
      record.ownerInstanceId === next.ownerInstanceId &&
      record.sourceConversationId === next.sourceConversationId &&
      isGoalClaimed(record.state)
    ) {
      throw new Error(`Conversation already has active goal "${record.goalId}".`);
    }
  }
}

/** A write that claims a conversation checks, under the activation lock, that no other goal holds it. */
const oneActiveGoalPerConversation: WriteGuard<GoalRecord> = async (
  record,
  write,
  others,
  exclusive,
) => {
  if (!claimsConversation(record)) {
    await write();
    return;
  }
  await exclusive("active-goals", async () => {
    assertNoActiveConversationConflict(record, await others());
    await write();
  });
};

function asEffect<A>(operation: () => Promise<A>): Effect.Effect<A, Error> {
  return Effect.tryPromise({ try: operation, catch: toError });
}

/** In-memory implementation with the same create, transition, and version semantics. */
export class InMemoryGoalStore implements GoalStore {
  private readonly records = new InMemoryRecords(GOAL_KIND, oneActiveGoalPerConversation);

  create(input: Omit<GoalRecord, "version">): Effect.Effect<GoalRecord, Error> {
    return asEffect(() => this.records.create(input));
  }

  get(goalId: GoalId): Effect.Effect<GoalRecord | undefined, never> {
    return Effect.sync(() => this.records.get(goalId));
  }

  list(filter?: Parameters<GoalStore["list"]>[0]): Effect.Effect<readonly GoalRecord[], never> {
    return Effect.sync(() => selectRecords(this.records.all(), filter));
  }

  compareAndSet(
    goalId: GoalId,
    expectedVersion: number,
    next: Omit<GoalRecord, "version">,
  ): Effect.Effect<GoalRecord, Error> {
    return asEffect(() => this.records.compareAndSet(goalId, expectedVersion, next));
  }
}

/** File-backed goal storage under `$JAZZ_HOME/goals`. */
export class FileGoalStore implements GoalStore {
  private readonly records: FileRecords<GoalRecord>;

  constructor(directory: string = getGoalsDirectory()) {
    this.records = new FileRecords(GOAL_KIND, directory, oneActiveGoalPerConversation);
  }

  create(input: Omit<GoalRecord, "version">): Effect.Effect<GoalRecord, Error> {
    return asEffect(() => this.records.create(input));
  }

  get(goalId: GoalId): Effect.Effect<GoalRecord | undefined, never> {
    if (!isGoalId(goalId)) {
      return Effect.succeed(undefined);
    }
    return asEffect(() => this.records.read(goalId)).pipe(Effect.orDie);
  }

  list(filter?: Parameters<GoalStore["list"]>[0]): Effect.Effect<readonly GoalRecord[], never> {
    return asEffect(async () => selectRecords(await this.records.all(), filter)).pipe(Effect.orDie);
  }

  compareAndSet(
    goalId: GoalId,
    expectedVersion: number,
    next: Omit<GoalRecord, "version">,
  ): Effect.Effect<GoalRecord, Error> {
    return asEffect(() => this.records.compareAndSet(goalId, expectedVersion, next));
  }
}

export function makeInMemoryGoalStoreLayer(): Layer.Layer<GoalStoreTag> {
  return Layer.succeed(GoalStoreTag, new InMemoryGoalStore());
}

export function makeFileGoalStoreLayer(directory?: string): Layer.Layer<GoalStoreTag> {
  return Layer.succeed(GoalStoreTag, new FileGoalStore(directory));
}
