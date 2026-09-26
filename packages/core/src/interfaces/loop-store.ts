import { Context, Effect } from "effect";
import type { LoopRecord, LoopRecordInput, LoopStateKind } from "@/core/agent/loop/loop-record";

/**
 * Durable storage for loops. Compare-and-set writes serialize run claims, settlements, and the
 * user's controls, so a loop never has two runs in flight and a pause is never lost.
 */
export interface LoopStore {
  readonly create: (record: LoopRecordInput) => Effect.Effect<LoopRecord, Error>;
  readonly get: (loopId: string) => Effect.Effect<LoopRecord | undefined, never>;
  readonly list: (filter?: {
    readonly ownerInstanceId?: string;
    readonly agentId?: string;
    readonly sourceConversationId?: string;
    readonly states?: readonly LoopStateKind[];
  }) => Effect.Effect<readonly LoopRecord[], never>;
  readonly compareAndSet: (
    loopId: string,
    expectedVersion: number,
    next: LoopRecordInput,
  ) => Effect.Effect<LoopRecord, Error>;
}

export class LoopStoreTag extends Context.Tag("LoopStore")<LoopStoreTag, LoopStore>() {}
