/**
 * Durable storage for controller-owned goals.
 *
 * The file store keeps one atomic JSON record per goal, avoiding a shared index and allowing
 * clients to inspect goals while a controller updates a different record. Mutations use a
 * per-goal cross-process lock and compare-and-set version so two controllers cannot both
 * claim the same continuation or overwrite a pause/cancel decision. The in-memory store
 * implements the same lifecycle and version rules for foreground runs and tests.
 */

import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
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
import { writeJsonFileDurably } from "./durable-file";
import { withFileLock } from "./file-lock";

function isGoalId(value: string): boolean {
  return GOAL_ID_PATTERN.test(value);
}

function assertGoalId(value: string): void {
  if (!isGoalId(value)) {
    throw new Error(`"${value}" is not a usable goal id.`);
  }
}

function parseStoredGoalRecord(raw: string, expectedGoalId: string): GoalRecord {
  const parsed = parseGoalRecord(JSON.parse(raw) as unknown);
  if (!parsed.ok) {
    throw new Error(`Goal record "${expectedGoalId}" is invalid or corrupt: ${parsed.error}`);
  }
  if (parsed.goal.goalId !== expectedGoalId) {
    throw new Error(`Goal record "${expectedGoalId}" holds goal "${parsed.goal.goalId}".`);
  }
  return parsed.goal;
}

function assertNextVersion(expectedVersion: number, next: Omit<GoalRecord, "version">): void {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw new Error("Expected goal version must be a positive safe integer.");
  }
  if (!isGoalId(next.goalId)) {
    throw new Error(`"${next.goalId}" is not a usable goal id.`);
  }
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

function nextRecord(
  current: GoalRecord,
  expectedVersion: number,
  next: Omit<GoalRecord, "version">,
  now: Date,
): GoalRecord {
  assertNextVersion(expectedVersion, next);
  if (current.version !== expectedVersion) {
    throw new Error(
      `Goal "${current.goalId}" changed: expected version ${expectedVersion}, found ${current.version}.`,
    );
  }
  if (next.goalId !== current.goalId) {
    throw new Error("A goal update cannot change its id.");
  }
  if (current.version === Number.MAX_SAFE_INTEGER) {
    throw new Error(`Goal "${current.goalId}" has exhausted its version counter.`);
  }
  if (next.createdAt !== current.createdAt) {
    throw new Error("A goal update cannot change its creation time.");
  }
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
  const updated: GoalRecord = {
    ...next,
    state,
    version: expectedVersion + 1,
    updatedAt: now.toISOString(),
  };
  assertRecordValid(updated);
  return updated;
}

function assertRecordValid(record: GoalRecord): void {
  const parsed = parseGoalRecord(record);
  if (!parsed.ok) {
    throw new Error(`Goal record "${record.goalId}" is invalid: ${parsed.error}`);
  }
}

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
  goalId: string,
  next: Omit<GoalRecord, "version">,
  records: Iterable<GoalRecord>,
): void {
  if (!claimsConversation(next)) {
    return;
  }
  for (const record of records) {
    if (
      record.goalId !== goalId &&
      record.ownerInstanceId === next.ownerInstanceId &&
      record.sourceConversationId === next.sourceConversationId &&
      isGoalClaimed(record.state)
    ) {
      throw new Error(`Conversation already has active goal "${record.goalId}".`);
    }
  }
}

/** In-memory implementation with the same create, transition, and version semantics. */
export class InMemoryGoalStore implements GoalStore {
  private readonly records = new Map<GoalId, GoalRecord>();

  create(input: Omit<GoalRecord, "version">): Effect.Effect<GoalRecord, Error> {
    return Effect.try({
      try: () => {
        assertGoalId(input.goalId);
        if (this.records.has(input.goalId)) {
          throw new Error(`Goal "${input.goalId}" already exists.`);
        }
        const record: GoalRecord = { ...structuredClone(input), version: 1 };
        assertRecordValid(record);
        assertNoActiveConversationConflict(record.goalId, record, this.records.values());
        this.records.set(record.goalId, record);
        return structuredClone(record);
      },
      catch: toError,
    });
  }

  get(goalId: GoalId): Effect.Effect<GoalRecord | undefined, never> {
    if (!isGoalId(goalId)) {
      return Effect.succeed(undefined);
    }
    return Effect.sync(() => {
      const record = this.records.get(goalId);
      return record === undefined ? undefined : structuredClone(record);
    });
  }

  list(filter?: Parameters<GoalStore["list"]>[0]): Effect.Effect<readonly GoalRecord[], never> {
    return Effect.sync(() =>
      selectRecords([...this.records.values()], filter).map((record) => structuredClone(record)),
    );
  }

  compareAndSet(
    goalId: GoalId,
    expectedVersion: number,
    next: Omit<GoalRecord, "version">,
  ): Effect.Effect<GoalRecord, Error> {
    return Effect.try({
      try: () => {
        assertGoalId(goalId);
        const current = this.records.get(goalId);
        if (current === undefined) {
          throw new Error(`No goal with id "${goalId}".`);
        }
        const updated = nextRecord(current, expectedVersion, next, new Date());
        assertNoActiveConversationConflict(goalId, next, this.records.values());
        this.records.set(goalId, updated);
        return structuredClone(updated);
      },
      catch: toError,
    });
  }
}

/**
 * File-backed goal storage. Updates are locked per goal, version-checked, and atomically
 * replaced with mode 0600 under a mode 0700 directory. Reads fail loudly on corruption so
 * a damaged controller record is never mistaken for an absent goal.
 */
export class FileGoalStore implements GoalStore {
  constructor(private readonly directory: string = getGoalsDirectory()) {}

  private pathFor(goalId: GoalId): string {
    assertGoalId(goalId);
    return path.join(this.directory, `${goalId}.json`);
  }

  private lockPathFor(goalId: GoalId): string {
    return `${this.pathFor(goalId)}.lock`;
  }

  private async readFile(goalId: GoalId): Promise<GoalRecord | undefined> {
    try {
      const raw = await nodeFs.readFile(this.pathFor(goalId), "utf8");
      return parseStoredGoalRecord(raw, goalId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Read a record found by listing the directory. A corrupt record is reported and skipped
   * here, so one damaged file does not stop every other goal from being listed, scheduled,
   * or activated; reading it by id still fails loudly.
   */
  private async readListedFile(goalId: GoalId): Promise<GoalRecord | undefined> {
    try {
      return await this.readFile(goalId);
    } catch (error) {
      console.error(`[goals] Skipping goal "${goalId}": ${toError(error).message}`);
      return undefined;
    }
  }

  private async ensureDirectory(): Promise<void> {
    await nodeFs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await nodeFs.chmod(this.directory, 0o700);
  }

  private async withGoalLock<A>(goalId: GoalId, operation: () => Promise<A>): Promise<A> {
    await this.ensureDirectory();
    return withFileLock(this.lockPathFor(goalId), operation);
  }

  /**
   * Write a record, holding the activation lock while it claims a conversation so two goals
   * cannot both become its active goal.
   */
  private async writeClaimChecked(goalId: GoalId, record: GoalRecord): Promise<void> {
    if (!claimsConversation(record)) {
      await writeJsonFileDurably(this.pathFor(goalId), record);
      return;
    }
    await withFileLock(path.join(this.directory, ".active-goals.lock"), async () => {
      assertNoActiveConversationConflict(goalId, record, await this.readAllListed());
      await writeJsonFileDurably(this.pathFor(goalId), record);
    });
  }

  private async readAllListed(): Promise<GoalRecord[]> {
    let entries: readonly string[];
    try {
      entries = await nodeFs.readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const records: GoalRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const goalId = entry.slice(0, -".json".length);
      if (!isGoalId(goalId)) {
        continue;
      }
      const record = await this.readListedFile(goalId);
      if (record !== undefined) {
        records.push(record);
      }
    }
    return records;
  }

  create(input: Omit<GoalRecord, "version">): Effect.Effect<GoalRecord, Error> {
    return Effect.tryPromise({
      try: () => {
        assertGoalId(input.goalId);
        return this.withGoalLock(input.goalId, async () => {
          if (await this.readFile(input.goalId)) {
            throw new Error(`Goal "${input.goalId}" already exists.`);
          }
          const record: GoalRecord = { ...structuredClone(input), version: 1 };
          assertRecordValid(record);
          await this.writeClaimChecked(record.goalId, record);
          return structuredClone(record);
        });
      },
      catch: toError,
    });
  }

  get(goalId: GoalId): Effect.Effect<GoalRecord | undefined, never> {
    if (!isGoalId(goalId)) {
      return Effect.succeed(undefined);
    }
    return Effect.tryPromise({
      try: () => this.readFile(goalId),
      catch: toError,
    }).pipe(Effect.catchAll((error) => Effect.die(error)));
  }

  list(filter?: Parameters<GoalStore["list"]>[0]): Effect.Effect<readonly GoalRecord[], never> {
    return Effect.tryPromise({
      try: async () =>
        selectRecords(await this.readAllListed(), filter).map((record) => structuredClone(record)),
      catch: toError,
    }).pipe(Effect.catchAll((error) => Effect.die(error)));
  }

  compareAndSet(
    goalId: GoalId,
    expectedVersion: number,
    next: Omit<GoalRecord, "version">,
  ): Effect.Effect<GoalRecord, Error> {
    return Effect.tryPromise({
      try: () => {
        assertGoalId(goalId);
        return this.withGoalLock(goalId, async () => {
          const current = await this.readFile(goalId);
          if (current === undefined) {
            throw new Error(`No goal with id "${goalId}".`);
          }
          const updated = nextRecord(current, expectedVersion, next, new Date());
          await this.writeClaimChecked(goalId, updated);
          return structuredClone(updated);
        });
      },
      catch: toError,
    });
  }
}

export function makeInMemoryGoalStoreLayer(): Layer.Layer<GoalStoreTag> {
  return Layer.succeed(GoalStoreTag, new InMemoryGoalStore());
}

export function makeFileGoalStoreLayer(directory?: string): Layer.Layer<GoalStoreTag> {
  return Layer.succeed(GoalStoreTag, new FileGoalStore(directory));
}
