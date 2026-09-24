/**
 * Records memory opportunity receipts for one run, so the agent loop only says
 * when a request starts and when it was accepted.
 *
 * The memory snapshot is taken once and reused until this run changes memory
 * itself. Walking and hashing every entry before every model request would put
 * work proportional to everything ever remembered in front of each call. Writes
 * by other processes show up on the next run.
 */
import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import type { LoggerService } from "@/core/interfaces/logger";
import type { MemoryEntrySnapshot, MemorySnapshot } from "@/core/interfaces/memory-service";
import type { ChatMessage } from "@/core/types/message";
import {
  beginMemoryOpportunities,
  completeMemoryOpportunities,
  type MemoryOpportunityTicket,
} from "./memory-opportunity-receipts";
import { telemetryErrorCategory } from "./metrics/agent-run-metrics";

export interface MemoryOpportunityRecorder {
  /** Write pending receipts for the request about to be sent. Never fails. */
  readonly begin: (request: {
    readonly runId: string;
    readonly iteration: number;
    readonly messages: readonly ChatMessage[];
  }) => Effect.Effect<readonly MemoryOpportunityTicket[]>;
  /** Complete the receipts once the provider accepted the request. Never fails. */
  readonly complete: (
    tickets: readonly MemoryOpportunityTicket[],
    messages: readonly ChatMessage[],
  ) => Effect.Effect<void>;
  /** Called after this run changes memory, so the next request sees the change. */
  readonly invalidateSnapshot: () => void;
}

export function createMemoryOpportunityRecorder(options: {
  readonly snapshotEntries: () => Effect.Effect<MemorySnapshot, Error, FileSystem.FileSystem>;
  readonly fileSystem: FileSystem.FileSystem;
  readonly logger: LoggerService;
  readonly viewMemoryOffered: boolean;
  readonly receiptsDirectory?: string;
}): MemoryOpportunityRecorder {
  let snapshot: readonly MemoryEntrySnapshot[] | undefined;

  const logFailure = (stage: string) => (error: Error) =>
    options.logger.warn("Memory opportunity receipts failed; continuing without them", {
      stage,
      errorCategory: telemetryErrorCategory(error),
    });

  const currentSnapshot = Effect.suspend(() =>
    snapshot !== undefined
      ? Effect.succeed(snapshot)
      : options.snapshotEntries().pipe(
          Effect.tap(({ unreadableScopes }) =>
            unreadableScopes.length === 0
              ? Effect.void
              : options.logger.warn("Some memory scopes could not be read for receipts", {
                  unreadableScopeCount: unreadableScopes.length,
                }),
          ),
          Effect.map(({ entries }) => entries),
          Effect.tap((entries) =>
            Effect.sync(() => {
              snapshot = entries;
            }),
          ),
        ),
  );

  return {
    begin: (request) =>
      currentSnapshot.pipe(
        Effect.flatMap((entries) =>
          beginMemoryOpportunities({
            ...request,
            entries,
            viewMemoryOffered: options.viewMemoryOffered,
            ...(options.receiptsDirectory !== undefined
              ? { receiptsDirectory: options.receiptsDirectory }
              : {}),
          }),
        ),
        Effect.provideService(FileSystem.FileSystem, options.fileSystem),
        Effect.catchAll((error) =>
          logFailure("begin")(error).pipe(Effect.as<readonly MemoryOpportunityTicket[]>([])),
        ),
      ),
    complete: (tickets, messages) =>
      completeMemoryOpportunities(tickets, messages).pipe(
        Effect.provideService(FileSystem.FileSystem, options.fileSystem),
        Effect.catchAll(logFailure("complete")),
      ),
    invalidateSnapshot: () => {
      snapshot = undefined;
    },
  };
}
