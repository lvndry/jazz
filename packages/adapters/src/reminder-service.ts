/**
 * Implements `ReminderService`: per-agent reminders persisted as one lock-guarded JSON file
 * per agent under the jazz home directory.
 */

import * as path from "node:path";
import { FileSystem } from "@effect/platform";
import { MAX_REMINDERS_PER_AGENT, REMINDER_TEXT_MAX_LENGTH } from "@jazz/core/constants/reminders";
import type {
  AddReminderOutcome,
  CancelReminderOutcome,
  ReminderRecord,
  ReminderService,
} from "@jazz/core/interfaces/reminder-service";
import { ReminderRecordSchema, ReminderServiceTag } from "@jazz/core/interfaces/reminder-service";
import { type DeliveryOutcome, hasStoppedRetrying } from "@jazz/core/utils/delivery";
import { toError } from "@jazz/core/utils/errors";
import { getJazzHomeDirectory } from "@jazz/core/utils/paths";
import { stateDirectoryMode } from "@jazz/core/utils/private-mode";
import { recordListKind, writeStateFile } from "@jazz/core/utils/state-file";
import { requireValidAgentId, withLock } from "@jazz/core/utils/storage";
import { parseWhen } from "@jazz/core/utils/time";
import {
  createReminderOsScheduler,
  type ReminderOsScheduler,
} from "@jazz/core/wake-triggers/reminder-os-scheduler";
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

/**
 * Version 2 added `delivery`. An older Jazz must refuse these files rather than read them
 * without it and fire a reminder that already failed for good.
 */
const REMINDER_SCHEMA_VERSION = 2;

/**
 * Telegram (`tg_...`) and Discord (`dc_...`) agents already sweep and deliver their own
 * reminders in-process (see `packages/telegram-bot/src/reminders.ts`,
 * `packages/discord-bot/src/reminders.ts`), running a private interval inside their own
 * long-lived bot process. Installing an OS job for those too would double-deliver: once as the
 * bot's own chat message, once as a spurious desktop notification on whatever host happens to
 * run the bot container — usually headless, with no GUI session, and often a shared service
 * account under which writing LaunchAgents would be unwanted or fail outright.
 */
export function isBotHostedAgentId(agentId: string): boolean {
  return agentId.startsWith("tg_") || agentId.startsWith("dc_");
}

/** Raised for guardrail violations — genuinely unexpected conditions, not tool-result-shaped errors. */
export class ReminderGuardrailViolation extends Error {}

function newReminderId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function reminderFilePath(baseReminderDirectory: string, agentId: string): string {
  return path.join(baseReminderDirectory, `${agentId}.json`);
}

function reminderLockPath(baseReminderDirectory: string, agentId: string): string {
  return path.join(baseReminderDirectory, `${agentId}.lock`);
}

const REMINDER_FILE_KIND = recordListKind("reminders", "reminders", ReminderRecordSchema, {
  schemaVersion: REMINDER_SCHEMA_VERSION,
});

/** Where reminders live, for the shared claim and settle logic in `scheduled-items.ts`. */
export const REMINDER_STORE: ScheduledItemStore<ReminderRecord> = {
  noun: "reminder",
  kind: REMINDER_FILE_KIND,
  filePath: reminderFilePath,
  lockPath: reminderLockPath,
};

function readReminderFile(filePath: string): Effect.Effect<ReminderRecord[], Error> {
  return readItemsLocked(REMINDER_STORE, filePath);
}

function writeReminderFile(
  filePath: string,
  reminders: readonly ReminderRecord[],
): Effect.Effect<void, Error> {
  return writeStateFile(filePath, REMINDER_FILE_KIND, [...reminders]);
}

export interface ReminderServiceImplOptions {
  /** Override for tests; defaults to ~/.jazz/reminders (or $JAZZ_HOME/reminders). */
  readonly baseReminderDirectory?: string;
  /** Override for tests; defaults to `createReminderOsScheduler()`. */
  readonly osScheduler?: ReminderOsScheduler;
}

export class ReminderServiceImpl implements ReminderService {
  private readonly baseReminderDirectory: string;
  private readonly osScheduler: ReminderOsScheduler | undefined;

  constructor(options?: ReminderServiceImplOptions) {
    this.baseReminderDirectory =
      options?.baseReminderDirectory ?? path.join(getJazzHomeDirectory(), "reminders");
    this.osScheduler = options?.osScheduler;
  }

  private resolveOsScheduler(): Effect.Effect<ReminderOsScheduler> {
    return this.osScheduler !== undefined
      ? Effect.succeed(this.osScheduler)
      : createReminderOsScheduler();
  }

  private withValidatedAgentLock<A, E, R>(
    agentId: string,
    operation: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | ReminderGuardrailViolation | Error, R | FileSystem.FileSystem> {
    const lockPath = reminderLockPath(this.baseReminderDirectory, agentId);
    const baseReminderDirectory = this.baseReminderDirectory;
    return Effect.gen(function* () {
      yield* requireValidAgentId(agentId, ReminderGuardrailViolation);
      const fs = yield* FileSystem.FileSystem;
      yield* fs
        .makeDirectory(baseReminderDirectory, { recursive: true, mode: stateDirectoryMode() })
        .pipe(Effect.catchAll((error) => Effect.fail(toError(error))));
      return yield* withLock(lockPath, operation);
    });
  }

  readonly add: ReminderService["add"] = (agentId, when, text, timezone) =>
    this.withValidatedAgentLock(
      agentId,
      Effect.gen(
        function* (this: ReminderServiceImpl) {
          const filePath = reminderFilePath(this.baseReminderDirectory, agentId);
          const existing = yield* readReminderFile(filePath);

          if (text.length > REMINDER_TEXT_MAX_LENGTH) {
            return yield* Effect.fail(
              new ReminderGuardrailViolation(
                `Reminder text is ${text.length} characters, exceeding the maximum of ${REMINDER_TEXT_MAX_LENGTH}.`,
              ),
            );
          }
          const pending = existing.filter((reminder) => !hasStoppedRetrying(reminder.delivery));
          if (pending.length >= MAX_REMINDERS_PER_AGENT) {
            return yield* Effect.fail(
              new ReminderGuardrailViolation(
                `You already have ${pending.length} pending reminders, the maximum of ${MAX_REMINDERS_PER_AGENT}.`,
              ),
            );
          }

          const now = Date.now();
          const fireAt = parseWhen(when, now, timezone);
          if (fireAt === null) {
            return {
              success: false,
              message: `Could not understand the time '${when}' — try things like '30m', '2h', '18:00', 'tomorrow 09:00', 'tue 20:00', or '2026-08-25 20:00'.`,
            } satisfies AddReminderOutcome;
          }
          if (fireAt <= now) {
            return {
              success: false,
              message: `'${when}' resolves to ${new Date(fireAt).toISOString()}, which is already in the past. Pick a future time.`,
            } satisfies AddReminderOutcome;
          }

          const reminderId = newReminderId();

          // OS scheduling is a best-effort reliability upgrade on top of the JSON record
          // below, which stays the source of truth — a scheduling failure must never block
          // registering the reminder, so any error here is swallowed. Skipped entirely for
          // bot-hosted agents; see `isBotHostedAgentId`.
          const scheduleResult: { readonly osSchedulerJobId?: string } = isBotHostedAgentId(agentId)
            ? {}
            : yield* (yield* this.resolveOsScheduler())
                .scheduleFire(agentId, reminderId, fireAt)
                .pipe(Effect.catchAll(() => Effect.succeed({})));

          const reminder: ReminderRecord = {
            id: reminderId,
            fireAt,
            text,
            createdAt: now,
            ...(scheduleResult.osSchedulerJobId !== undefined
              ? { osSchedulerJobId: scheduleResult.osSchedulerJobId }
              : {}),
          };
          yield* writeReminderFile(filePath, [...existing, reminder]);

          return { success: true, reminder } satisfies AddReminderOutcome;
        }.bind(this),
      ),
    );

  readonly list: ReminderService["list"] = (agentId) =>
    this.withValidatedAgentLock(
      agentId,
      readReminderFile(reminderFilePath(this.baseReminderDirectory, agentId)),
    );

  readonly cancel: ReminderService["cancel"] = (agentId, id) =>
    this.withValidatedAgentLock(
      agentId,
      Effect.gen(
        function* (this: ReminderServiceImpl) {
          const filePath = reminderFilePath(this.baseReminderDirectory, agentId);
          const existing = yield* readReminderFile(filePath);
          const removedReminder = existing.find((reminder) => reminder.id === id);

          if (removedReminder === undefined) {
            return {
              success: false,
              message: `No reminder found with id "${id}".`,
            } satisfies CancelReminderOutcome;
          }

          const remaining = existing.filter((reminder) => reminder.id !== id);
          yield* writeReminderFile(filePath, remaining);

          // Never let a failed OS unschedule block removing the JSON record — the record is
          // the source of truth, and a stray leftover `at`/launchd job is harmless (the CLI
          // it invokes checks whether the reminder still exists before firing). Skipped
          // entirely for bot-hosted agents, which never had a job installed to begin with.
          if (!isBotHostedAgentId(agentId)) {
            const osScheduler = yield* this.resolveOsScheduler();
            yield* osScheduler
              .cancelFire(agentId, id, removedReminder.osSchedulerJobId)
              .pipe(Effect.catchAll(() => Effect.void));
          }

          return { success: true, message: "Reminder cancelled." } satisfies CancelReminderOutcome;
        }.bind(this),
      ),
    );
}

export function createReminderServiceLayer(
  options?: ReminderServiceImplOptions,
): Layer.Layer<ReminderService> {
  return Layer.succeed(ReminderServiceTag, new ReminderServiceImpl(options));
}

/**
 * Claim every due reminder under `baseReminderDirectory`, across agents, for delivery (see
 * `scheduled-items.ts`). The caller delivers each claim and settles it with
 * {@link settleReminder}. When `osScheduler` is given, the host scheduler's one-shot job for
 * each claimed reminder is removed, since the reminder is now being delivered from here.
 *
 * Callable from plain async code (a chat bridge's `setInterval` sweep) through one
 * `Effect.runPromise`, so the sweep and the tool handlers share the same lock.
 */
export function claimDueReminders(
  baseReminderDirectory: string,
  now: number,
  options: {
    readonly includeAgent?: (agentId: string) => boolean;
    readonly osScheduler?: ReminderOsScheduler;
  } = {},
): Effect.Effect<ReadonlyArray<ScheduledItemClaim<ReminderRecord>>, Error> {
  return Effect.gen(function* () {
    const claims = yield* claimDueItems(REMINDER_STORE, baseReminderDirectory, now, options);
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

/** Claim one reminder by id for delivery; undefined when it is gone or already being delivered. */
export function claimReminder(
  baseReminderDirectory: string,
  agentId: string,
  reminderId: string,
): Effect.Effect<ReminderRecord | undefined, Error> {
  return claimItem(REMINDER_STORE, baseReminderDirectory, agentId, reminderId, Date.now());
}

/**
 * Record how a claimed reminder's delivery ended and release the claim: delivered reminders
 * are removed; failed ones keep the error so a later sweep (or another channel) can retry.
 */
export function settleReminder(
  baseReminderDirectory: string,
  agentId: string,
  reminderId: string,
  outcome: DeliveryOutcome,
): Effect.Effect<ReminderRecord | undefined, Error> {
  return settleItem(REMINDER_STORE, baseReminderDirectory, agentId, reminderId, outcome).pipe(
    Effect.ensuring(Effect.sync(() => finishClaim(REMINDER_STORE, agentId, reminderId))),
  );
}
