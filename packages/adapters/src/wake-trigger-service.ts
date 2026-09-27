/**
 * Implements `WakeTriggerService`: per-agent wake-ups persisted as one lock-guarded JSON file
 * per agent under the jazz home directory. Structurally identical to `ReminderService` —
 * same per-agent file, same lock, same sweep shape — because a wake-up and a reminder are
 * both "the agent scheduled something for later"; they differ only in what firing does with
 * it (resume the agent vs. notify a person), which is the caller's job, not this store's.
 */

import * as path from "node:path";
import { FileSystem } from "@effect/platform";
import {
  MAX_WAKE_TRIGGERS_PER_AGENT,
  WAKE_TRIGGER_PROMPT_MAX_LENGTH,
  WAKE_TRIGGER_REASON_MAX_LENGTH,
} from "@jazz/core/constants/wake-triggers";
import type {
  AddWakeTriggerOutcome,
  CancelWakeTriggerOutcome,
  WakeTriggerRecord,
  WakeTriggerService,
} from "@jazz/core/interfaces/wake-trigger-service";
import {
  WakeTriggerRecordSchema,
  WakeTriggerServiceTag,
} from "@jazz/core/interfaces/wake-trigger-service";
import { type DeliveryOutcome, hasStoppedRetrying } from "@jazz/core/utils/delivery";
import { toError } from "@jazz/core/utils/errors";
import { getJazzHomeDirectory } from "@jazz/core/utils/paths";
import { stateDirectoryMode } from "@jazz/core/utils/private-mode";
import { recordListKind, writeStateFile } from "@jazz/core/utils/state-file";
import { requireValidAgentId, withLock } from "@jazz/core/utils/storage";
import { parseWhen } from "@jazz/core/utils/time";
import {
  createWakeTriggerOsScheduler,
  type WakeTriggerOsScheduler,
} from "@jazz/core/wake-triggers/wake-trigger-os-scheduler";
import { Effect, Layer } from "effect";
import {
  claimDueItems,
  claimItem,
  finishClaim,
  readItemsLocked,
  type ScheduledItemClaim,
  type ScheduledItemStore,
  settleItem,
} from "@/adapters/storage/scheduled-items";

/** Raised for guardrail violations — genuinely unexpected conditions, not tool-result-shaped errors. */
export class WakeTriggerGuardrailViolation extends Error {}

function newWakeTriggerId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function wakeTriggerFilePath(baseDirectory: string, agentId: string): string {
  return path.join(baseDirectory, `${agentId}.json`);
}

function wakeTriggerLockPath(baseDirectory: string, agentId: string): string {
  return path.join(baseDirectory, `${agentId}.lock`);
}

/**
 * Version 2 added `delivery`. An older Jazz must refuse these files rather than read them
 * without it and fire a trigger that already failed for good.
 */
const WAKE_TRIGGER_SCHEMA_VERSION = 2;

const WAKE_TRIGGER_FILE_KIND = recordListKind(
  "wake triggers",
  "triggers",
  WakeTriggerRecordSchema,
  {
    schemaVersion: WAKE_TRIGGER_SCHEMA_VERSION,
  },
);

/** Where wake triggers live, for the shared claim and settle logic in `scheduled-items.ts`. */
export const WAKE_TRIGGER_STORE: ScheduledItemStore<WakeTriggerRecord> = {
  noun: "wake trigger",
  kind: WAKE_TRIGGER_FILE_KIND,
  filePath: wakeTriggerFilePath,
  lockPath: wakeTriggerLockPath,
};

function readWakeTriggerFile(filePath: string): Effect.Effect<WakeTriggerRecord[], Error> {
  return readItemsLocked(WAKE_TRIGGER_STORE, filePath);
}

function writeWakeTriggerFile(
  filePath: string,
  triggers: readonly WakeTriggerRecord[],
): Effect.Effect<void, Error> {
  return writeStateFile(filePath, WAKE_TRIGGER_FILE_KIND, [...triggers]);
}

export interface WakeTriggerServiceImplOptions {
  /** Override for tests; defaults to ~/.jazz/wake-triggers (or $JAZZ_HOME/wake-triggers). */
  readonly baseWakeTriggerDirectory?: string;
  /** Override for tests; defaults to `createWakeTriggerOsScheduler()`. */
  readonly osScheduler?: WakeTriggerOsScheduler;
}

export class WakeTriggerServiceImpl implements WakeTriggerService {
  private readonly baseWakeTriggerDirectory: string;
  private readonly osScheduler: WakeTriggerOsScheduler | undefined;

  constructor(options?: WakeTriggerServiceImplOptions) {
    this.baseWakeTriggerDirectory =
      options?.baseWakeTriggerDirectory ?? path.join(getJazzHomeDirectory(), "wake-triggers");
    this.osScheduler = options?.osScheduler;
  }

  private resolveOsScheduler(): Effect.Effect<WakeTriggerOsScheduler> {
    return this.osScheduler !== undefined
      ? Effect.succeed(this.osScheduler)
      : createWakeTriggerOsScheduler();
  }

  private withValidatedAgentLock<A, E, R>(
    agentId: string,
    operation: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | WakeTriggerGuardrailViolation | Error, R | FileSystem.FileSystem> {
    const lockPath = wakeTriggerLockPath(this.baseWakeTriggerDirectory, agentId);
    const baseWakeTriggerDirectory = this.baseWakeTriggerDirectory;
    return Effect.gen(function* () {
      yield* requireValidAgentId(agentId, WakeTriggerGuardrailViolation);
      const fs = yield* FileSystem.FileSystem;
      yield* fs
        .makeDirectory(baseWakeTriggerDirectory, { recursive: true, mode: stateDirectoryMode() })
        .pipe(Effect.catchAll((error) => Effect.fail(toError(error))));
      return yield* withLock(lockPath, operation);
    });
  }

  readonly add: WakeTriggerService["add"] = (
    agentId,
    conversationId,
    when,
    prompt,
    reason,
    timezone,
  ) =>
    this.withValidatedAgentLock(
      agentId,
      Effect.gen(
        function* (this: WakeTriggerServiceImpl) {
          const filePath = wakeTriggerFilePath(this.baseWakeTriggerDirectory, agentId);
          const existing = yield* readWakeTriggerFile(filePath);

          if (prompt.length > WAKE_TRIGGER_PROMPT_MAX_LENGTH) {
            return yield* Effect.fail(
              new WakeTriggerGuardrailViolation(
                `Trigger prompt is ${prompt.length} characters, exceeding the maximum of ${WAKE_TRIGGER_PROMPT_MAX_LENGTH}.`,
              ),
            );
          }
          if (reason.length > WAKE_TRIGGER_REASON_MAX_LENGTH) {
            return yield* Effect.fail(
              new WakeTriggerGuardrailViolation(
                `Trigger reason is ${reason.length} characters, exceeding the maximum of ${WAKE_TRIGGER_REASON_MAX_LENGTH}.`,
              ),
            );
          }
          const pending = existing.filter((trigger) => !hasStoppedRetrying(trigger.delivery));
          if (pending.length >= MAX_WAKE_TRIGGERS_PER_AGENT) {
            return yield* Effect.fail(
              new WakeTriggerGuardrailViolation(
                `You already have ${pending.length} pending wake triggers, the maximum of ${MAX_WAKE_TRIGGERS_PER_AGENT}. Cancel one with cancel_trigger before registering another.`,
              ),
            );
          }

          const now = Date.now();
          const fireAt = parseWhen(when, now, timezone);
          if (fireAt === null) {
            return {
              success: false,
              message: `Could not understand the time '${when}' — try things like '30m', '2h', '18:00', 'tomorrow 09:00', 'tue 20:00', or '2026-08-25 20:00'.`,
            } satisfies AddWakeTriggerOutcome;
          }
          if (fireAt <= now) {
            return {
              success: false,
              message: `'${when}' resolves to ${new Date(fireAt).toISOString()}, which is already in the past. Pick a future time.`,
            } satisfies AddWakeTriggerOutcome;
          }

          const triggerId = newWakeTriggerId();

          // OS scheduling is a best-effort reliability upgrade on top of the JSON record
          // below, which stays the source of truth — a scheduling failure must never block
          // registering the trigger, so any error here is swallowed.
          const osScheduler = yield* this.resolveOsScheduler();
          const scheduleResult = yield* osScheduler
            .scheduleFire(agentId, triggerId, fireAt)
            .pipe(Effect.catchAll(() => Effect.succeed({ osSchedulerJobId: undefined })));

          const trigger: WakeTriggerRecord = {
            id: triggerId,
            fireAt,
            conversationId,
            prompt,
            reason,
            createdAt: now,
            ...(scheduleResult.osSchedulerJobId !== undefined
              ? { osSchedulerJobId: scheduleResult.osSchedulerJobId }
              : {}),
          };
          yield* writeWakeTriggerFile(filePath, [...existing, trigger]);

          return { success: true, trigger } satisfies AddWakeTriggerOutcome;
        }.bind(this),
      ),
    );

  readonly list: WakeTriggerService["list"] = (agentId) =>
    this.withValidatedAgentLock(
      agentId,
      readWakeTriggerFile(wakeTriggerFilePath(this.baseWakeTriggerDirectory, agentId)),
    );

  readonly cancel: WakeTriggerService["cancel"] = (agentId, id) =>
    this.withValidatedAgentLock(
      agentId,
      Effect.gen(
        function* (this: WakeTriggerServiceImpl) {
          const filePath = wakeTriggerFilePath(this.baseWakeTriggerDirectory, agentId);
          const existing = yield* readWakeTriggerFile(filePath);
          const removedTrigger = existing.find((trigger) => trigger.id === id);

          if (removedTrigger === undefined) {
            return {
              success: false,
              message: `No wake trigger found with id "${id}".`,
            } satisfies CancelWakeTriggerOutcome;
          }

          const remaining = existing.filter((trigger) => trigger.id !== id);
          yield* writeWakeTriggerFile(filePath, remaining);

          // Never let a failed OS unschedule block removing the JSON record — the record is
          // the source of truth, and a stray leftover `at`/launchd job is harmless (the CLI
          // it invokes checks whether the trigger still exists before firing).
          const osScheduler = yield* this.resolveOsScheduler();
          yield* osScheduler
            .cancelFire(agentId, id, removedTrigger.osSchedulerJobId)
            .pipe(Effect.catchAll(() => Effect.void));

          return {
            success: true,
            message: "Wake trigger cancelled.",
          } satisfies CancelWakeTriggerOutcome;
        }.bind(this),
      ),
    );
}

export function createWakeTriggerServiceLayer(
  options?: WakeTriggerServiceImplOptions,
): Layer.Layer<WakeTriggerService> {
  return Layer.succeed(WakeTriggerServiceTag, new WakeTriggerServiceImpl(options));
}

/**
 * Claim every due wake trigger under `baseWakeTriggerDirectory`, across agents, for delivery
 * (see `scheduled-items.ts`). The caller runs each claimed turn and settles it with
 * {@link settleWakeTrigger}. When `osScheduler` is given, the host scheduler's one-shot job for
 * each claimed trigger is removed, since the trigger is now being fired from here.
 */
export function claimDueWakeTriggers(
  baseWakeTriggerDirectory: string,
  now: number,
  options: { readonly osScheduler?: WakeTriggerOsScheduler } = {},
): Effect.Effect<ReadonlyArray<ScheduledItemClaim<WakeTriggerRecord>>, Error> {
  return Effect.gen(function* () {
    const claims = yield* claimDueItems(WAKE_TRIGGER_STORE, baseWakeTriggerDirectory, now);
    const osScheduler = options.osScheduler;
    if (osScheduler !== undefined) {
      for (const { agentId, item } of claims) {
        yield* osScheduler
          .cancelFire(agentId, item.id, item.osSchedulerJobId)
          .pipe(Effect.catchAll(() => Effect.void));
      }
    }
    return claims;
  });
}

/** Claim one wake trigger by id; undefined when it is gone or already being fired. */
export function claimWakeTrigger(
  baseWakeTriggerDirectory: string,
  agentId: string,
  triggerId: string,
): Effect.Effect<WakeTriggerRecord | undefined, Error> {
  return claimItem(WAKE_TRIGGER_STORE, baseWakeTriggerDirectory, agentId, triggerId, Date.now());
}

/**
 * Record how a claimed trigger's turn ended and release the claim: delivered triggers are
 * removed; failed ones keep the error and retry with backoff while attempts remain.
 */
export function settleWakeTrigger(
  baseWakeTriggerDirectory: string,
  agentId: string,
  triggerId: string,
  outcome: DeliveryOutcome,
): Effect.Effect<WakeTriggerRecord | undefined, Error> {
  return settleItem(WAKE_TRIGGER_STORE, baseWakeTriggerDirectory, agentId, triggerId, outcome).pipe(
    Effect.ensuring(Effect.sync(() => finishClaim(WAKE_TRIGGER_STORE, agentId, triggerId))),
  );
}
