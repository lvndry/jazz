/**
 * Durable storage for loops: versioned records (`record-store.ts`), one JSON file per loop
 * under `$JAZZ_HOME/loops`, plus the rules a loop update must follow.
 */

import {
  LOOP_ID_PATTERN,
  isTerminalLoop,
  parseLoopRecord,
  type LoopRecord,
  type LoopRecordInput,
} from "@jazz/core/agent/loop/loop-record";
import { LoopStoreTag, type LoopStore } from "@jazz/core/interfaces/loop-store";
import { toError } from "@jazz/core/utils/errors";
import { getLoopsDirectory } from "@jazz/core/utils/paths";
import { Effect, Layer } from "effect";
import { FileRecords, InMemoryRecords, type RecordKind, type StampedUpdate } from "./record-store";

function nextLoopRecord(
  current: LoopRecord,
  next: LoopRecordInput,
  stamped: StampedUpdate,
): LoopRecord {
  if (isTerminalLoop(current.state)) {
    throw new Error(`Loop "${current.loopId}" is ${current.state.kind} and can no longer change.`);
  }
  if (
    next.ownerInstanceId !== current.ownerInstanceId ||
    next.agentId !== current.agentId ||
    next.conversationId !== current.conversationId ||
    next.sourceConversationId !== current.sourceConversationId ||
    next.workingDirectory !== current.workingDirectory ||
    next.prompt !== current.prompt ||
    JSON.stringify(next.schedule) !== JSON.stringify(current.schedule)
  ) {
    throw new Error(
      "A loop update cannot change its owner, agent, conversation, directory, prompt, or schedule.",
    );
  }
  if (
    next.usage.runs < current.usage.runs ||
    next.usage.totalTokens < current.usage.totalTokens ||
    next.usage.activeDurationMs < current.usage.activeDurationMs ||
    (!current.usage.costKnown && next.usage.costKnown)
  ) {
    throw new Error("Loop usage cannot move backwards or treat an unknown cost as known.");
  }
  if (current.run !== undefined && next.run !== undefined && next.run.runId !== current.run.runId) {
    throw new Error("A loop's run in flight must be settled before another is claimed.");
  }
  if (
    current.run === undefined &&
    next.run !== undefined &&
    next.usage.runs !== current.usage.runs + 1
  ) {
    throw new Error("Claiming a run must count it.");
  }
  return { ...next, ...stamped };
}

const LOOP_KIND: RecordKind<LoopRecord> = {
  noun: "loop",
  idOf: (record) => record.loopId,
  isId: (value) => LOOP_ID_PATTERN.test(value),
  parse: (value) => {
    const parsed = parseLoopRecord(value);
    return parsed.ok ? { ok: true, record: parsed.loop } : parsed;
  },
  nextRecord: nextLoopRecord,
};

function selectLoops(
  records: readonly LoopRecord[],
  filter: Parameters<LoopStore["list"]>[0],
): readonly LoopRecord[] {
  const states = filter?.states === undefined ? undefined : new Set(filter.states);
  return records
    .filter(
      (loop) =>
        (filter?.ownerInstanceId === undefined ||
          loop.ownerInstanceId === filter.ownerInstanceId) &&
        (filter?.agentId === undefined || loop.agentId === filter.agentId) &&
        (filter?.sourceConversationId === undefined ||
          loop.sourceConversationId === filter.sourceConversationId) &&
        (states === undefined || states.has(loop.state.kind)),
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function asEffect<A>(operation: () => Promise<A>): Effect.Effect<A, Error> {
  return Effect.tryPromise({ try: operation, catch: toError });
}

export class InMemoryLoopStore implements LoopStore {
  private readonly records = new InMemoryRecords(LOOP_KIND);

  create(input: LoopRecordInput): Effect.Effect<LoopRecord, Error> {
    return asEffect(() => this.records.create(input));
  }

  get(loopId: string): Effect.Effect<LoopRecord | undefined, never> {
    return Effect.sync(() => this.records.get(loopId));
  }

  list(filter?: Parameters<LoopStore["list"]>[0]): Effect.Effect<readonly LoopRecord[], never> {
    return Effect.sync(() => selectLoops(this.records.all(), filter));
  }

  compareAndSet(
    loopId: string,
    expectedVersion: number,
    next: LoopRecordInput,
  ): Effect.Effect<LoopRecord, Error> {
    return asEffect(() => this.records.compareAndSet(loopId, expectedVersion, next));
  }
}

export class FileLoopStore implements LoopStore {
  private readonly records: FileRecords<LoopRecord>;

  constructor(directory: string = getLoopsDirectory()) {
    this.records = new FileRecords(LOOP_KIND, directory);
  }

  create(input: LoopRecordInput): Effect.Effect<LoopRecord, Error> {
    return asEffect(() => this.records.create(input));
  }

  get(loopId: string): Effect.Effect<LoopRecord | undefined, never> {
    if (!LOOP_ID_PATTERN.test(loopId)) {
      return Effect.succeed(undefined);
    }
    return asEffect(() => this.records.read(loopId)).pipe(Effect.orDie);
  }

  list(filter?: Parameters<LoopStore["list"]>[0]): Effect.Effect<readonly LoopRecord[], never> {
    return asEffect(async () => selectLoops(await this.records.all(), filter)).pipe(Effect.orDie);
  }

  compareAndSet(
    loopId: string,
    expectedVersion: number,
    next: LoopRecordInput,
  ): Effect.Effect<LoopRecord, Error> {
    return asEffect(() => this.records.compareAndSet(loopId, expectedVersion, next));
  }
}

export function makeInMemoryLoopStoreLayer(): Layer.Layer<LoopStoreTag> {
  return Layer.succeed(LoopStoreTag, new InMemoryLoopStore());
}

export function makeFileLoopStoreLayer(directory?: string): Layer.Layer<LoopStoreTag> {
  return Layer.succeed(LoopStoreTag, new FileLoopStore(directory));
}
