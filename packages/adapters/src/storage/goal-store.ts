/**
 * Durable storage for controller-owned goals.
 *
 * The file store keeps one atomic JSON record per goal, avoiding a shared index and allowing
 * clients to inspect goals while a controller updates a different record. Mutations use a
 * per-goal cross-process lock and compare-and-set version so two controllers cannot both
 * claim the same continuation or overwrite a pause/cancel decision. The in-memory store
 * implements the same lifecycle and version rules for foreground runs and tests.
 */

import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import { hostname } from "node:os";
import * as path from "node:path";
import { parseGoalRecord, type GoalId, type GoalRecord } from "@jazz/core/agent/goal/goal-record";
import { transitionGoal } from "@jazz/core/agent/goal/goal-state";
import { GoalStoreTag, type GoalStore } from "@jazz/core/interfaces/goal-store";
import { getGoalsDirectory } from "@jazz/core/utils/paths";
import { Effect, Layer } from "effect";

const GOAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_DELAY_MS = 25;
const LOCK_MAX_WAIT_MS = 5_000;

interface GoalLockPayload {
  readonly pid: number;
  readonly host: string;
  readonly token: string;
}

function isGoalId(value: string): boolean {
  return GOAL_ID_PATTERN.test(value);
}

function assertGoalId(value: string): void {
  if (!isGoalId(value)) {
    throw new Error(`"${value}" is not a usable goal id.`);
  }
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function isGoalClaimed(state: GoalRecord["state"]): boolean {
  return state.kind === "active" || state.kind === "awaiting-input" || state.kind === "stopping";
}

function assertNoActiveConversationConflict(
  goalId: string,
  next: Omit<GoalRecord, "version">,
  records: Iterable<GoalRecord>,
): void {
  if (next.sourceConversationId === undefined || !isGoalClaimed(next.state)) {
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
      catch: normalizeError,
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
      catch: normalizeError,
    });
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLockPayload(lockDirectory: string): Promise<GoalLockPayload | undefined> {
  try {
    const parsed: unknown = JSON.parse(
      await nodeFs.readFile(path.join(lockDirectory, "owner.json"), "utf8"),
    );
    if (
      !isRecord(parsed) ||
      !Number.isSafeInteger(parsed["pid"]) ||
      typeof parsed["host"] !== "string" ||
      typeof parsed["token"] !== "string"
    ) {
      return undefined;
    }
    return parsed as unknown as GoalLockPayload;
  } catch {
    return undefined;
  }
}

async function goalLockIsStale(lockDirectory: string): Promise<boolean> {
  const stats = await nodeFs.stat(lockDirectory).catch(() => undefined);
  if (stats === undefined) {
    return true;
  }
  if (Date.now() - stats.mtimeMs <= LOCK_STALE_MS) {
    return false;
  }
  const payload = await readLockPayload(lockDirectory);
  if (payload === undefined) {
    return true;
  }
  if (payload.host !== hostname()) {
    return false;
  }
  return !processIsAlive(payload.pid);
}

async function removeStaleGoalLock(lockDirectory: string): Promise<void> {
  const quarantineDirectory = `${lockDirectory}.stale-${randomUUID()}`;
  try {
    await nodeFs.rename(lockDirectory, quarantineDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  await nodeFs.rm(quarantineDirectory, { recursive: true, force: true }).catch(() => undefined);
}

async function acquireGoalLock(lockDirectory: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  const token = randomUUID();
  const payload: GoalLockPayload = { pid: process.pid, host: hostname(), token };
  for (;;) {
    try {
      await nodeFs.mkdir(lockDirectory, { mode: 0o700 });
      try {
        await nodeFs.writeFile(path.join(lockDirectory, "owner.json"), JSON.stringify(payload), {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        await nodeFs.rm(lockDirectory, { recursive: true, force: true });
        throw error;
      }
      return async () => {
        const owner = await readLockPayload(lockDirectory);
        if (owner?.token === token) {
          await nodeFs.rm(lockDirectory, { recursive: true, force: true });
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (await goalLockIsStale(lockDirectory)) {
        await removeStaleGoalLock(lockDirectory);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for the goal lock at "${lockDirectory}".`, {
          cause: error,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
    }
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

  private async writeFile(record: GoalRecord): Promise<void> {
    const destination = this.pathFor(record.goalId);
    await nodeFs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await nodeFs.chmod(this.directory, 0o700);
    const temporary = path.join(
      this.directory,
      `.${record.goalId}-${process.pid}-${randomUUID()}.tmp`,
    );
    try {
      const handle = await nodeFs.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await nodeFs.rename(temporary, destination);
      await nodeFs.chmod(destination, 0o600);
    } finally {
      await nodeFs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async withGoalLock<A>(goalId: GoalId, operation: () => Promise<A>): Promise<A> {
    await nodeFs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await nodeFs.chmod(this.directory, 0o700);
    const release = await acquireGoalLock(this.lockPathFor(goalId));
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  private async withActivationLock<A>(operation: () => Promise<A>): Promise<A> {
    const release = await acquireGoalLock(path.join(this.directory, ".active-goals.lock"));
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  private async assertNoActiveConversationConflict(
    goalId: string,
    next: Omit<GoalRecord, "version">,
  ): Promise<void> {
    if (next.sourceConversationId === undefined || !isGoalClaimed(next.state)) {
      return;
    }
    const entries = await nodeFs.readdir(this.directory).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    });
    for (const entry of entries) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const candidateId = entry.slice(0, -5);
      if (candidateId === goalId || !isGoalId(candidateId)) {
        continue;
      }
      const record = await this.readFile(candidateId);
      if (
        record !== undefined &&
        record.ownerInstanceId === next.ownerInstanceId &&
        record.sourceConversationId === next.sourceConversationId &&
        isGoalClaimed(record.state)
      ) {
        throw new Error(`Conversation already has active goal "${record.goalId}".`);
      }
    }
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
          if (isGoalClaimed(record.state)) {
            await this.withActivationLock(() =>
              this.assertNoActiveConversationConflict(record.goalId, record),
            );
          }
          await this.writeFile(record);
          return structuredClone(record);
        });
      },
      catch: normalizeError,
    });
  }

  get(goalId: GoalId): Effect.Effect<GoalRecord | undefined, never> {
    if (!isGoalId(goalId)) {
      return Effect.succeed(undefined);
    }
    return Effect.tryPromise({
      try: () => this.readFile(goalId),
      catch: normalizeError,
    }).pipe(Effect.catchAll((error) => Effect.die(error)));
  }

  list(filter?: Parameters<GoalStore["list"]>[0]): Effect.Effect<readonly GoalRecord[], never> {
    return Effect.tryPromise({
      try: async () => {
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
          const record = await this.readFile(goalId);
          if (record !== undefined) {
            records.push(record);
          }
        }
        return selectRecords(records, filter).map((record) => structuredClone(record));
      },
      catch: normalizeError,
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
          if (isGoalClaimed(next.state)) {
            await this.withActivationLock(() =>
              this.assertNoActiveConversationConflict(goalId, next),
            );
          }
          await this.writeFile(updated);
          return structuredClone(updated);
        });
      },
      catch: normalizeError,
    });
  }
}

export function makeInMemoryGoalStoreLayer(): Layer.Layer<GoalStoreTag> {
  return Layer.succeed(GoalStoreTag, new InMemoryGoalStore());
}

export function makeFileGoalStoreLayer(directory?: string): Layer.Layer<GoalStoreTag> {
  return Layer.succeed(GoalStoreTag, new FileGoalStore(directory));
}
