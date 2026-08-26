import * as path from "node:path";
import { FileSystem } from "@effect/platform";
import { MAX_REMINDERS_PER_AGENT, REMINDER_TEXT_MAX_LENGTH } from "@jazz/core/constants/reminders";
import type {
  AddReminderOutcome,
  CancelReminderOutcome,
  ReminderRecord,
  ReminderService,
} from "@jazz/core/interfaces/reminder-service";
import { ReminderServiceTag } from "@jazz/core/interfaces/reminder-service";
import { getJazzHomeDirectory } from "@jazz/core/utils/paths";
import { requireValidAgentId, withLock, writeFileStringAtomic } from "@jazz/core/utils/storage";
import { parseWhen } from "@jazz/core/utils/time";
import { Effect, Layer } from "effect";

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

function readReminderFile(
  fs: FileSystem.FileSystem,
  filePath: string,
): Effect.Effect<ReminderRecord[], Error> {
  return Effect.gen(function* () {
    const exists = yield* fs.exists(filePath).pipe(Effect.catchAll(() => Effect.succeed(false)));
    if (!exists) return [];

    const content = yield* fs
      .readFileString(filePath)
      .pipe(Effect.catchAll((e) => Effect.fail(e instanceof Error ? e : new Error(String(e)))));

    try {
      const parsed = JSON.parse(content) as unknown;
      return Array.isArray(parsed) ? (parsed as ReminderRecord[]) : [];
    } catch {
      return [];
    }
  });
}

export interface ReminderServiceImplOptions {
  /** Override for tests; defaults to ~/.jazz/reminders (or $JAZZ_HOME/reminders). */
  readonly baseReminderDirectory?: string;
}

export class ReminderServiceImpl implements ReminderService {
  private readonly baseReminderDirectory: string;

  constructor(options?: ReminderServiceImplOptions) {
    this.baseReminderDirectory =
      options?.baseReminderDirectory ?? path.join(getJazzHomeDirectory(), "reminders");
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
        .makeDirectory(baseReminderDirectory, { recursive: true })
        .pipe(Effect.catchAll((e) => Effect.fail(e instanceof Error ? e : new Error(String(e)))));
      return yield* withLock(lockPath, operation);
    });
  }

  readonly add: ReminderService["add"] = (agentId, when, text, timezone) =>
    this.withValidatedAgentLock(
      agentId,
      Effect.gen(
        function* (this: ReminderServiceImpl) {
          const fs = yield* FileSystem.FileSystem;
          const filePath = reminderFilePath(this.baseReminderDirectory, agentId);
          const existing = yield* readReminderFile(fs, filePath);

          if (text.length > REMINDER_TEXT_MAX_LENGTH) {
            return yield* Effect.fail(
              new ReminderGuardrailViolation(
                `Reminder text is ${text.length} characters, exceeding the maximum of ${REMINDER_TEXT_MAX_LENGTH}.`,
              ),
            );
          }
          if (existing.length >= MAX_REMINDERS_PER_AGENT) {
            return yield* Effect.fail(
              new ReminderGuardrailViolation(
                `You already have ${existing.length} pending reminders, the maximum of ${MAX_REMINDERS_PER_AGENT}.`,
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

          const reminder: ReminderRecord = {
            id: newReminderId(),
            fireAt,
            text,
            createdAt: now,
          };
          yield* writeFileStringAtomic(
            fs,
            filePath,
            `${JSON.stringify([...existing, reminder], null, 2)}\n`,
            { tempPrefix: "reminders" },
          );

          return { success: true, reminder } satisfies AddReminderOutcome;
        }.bind(this),
      ),
    );

  readonly list: ReminderService["list"] = (agentId) =>
    Effect.gen(
      function* (this: ReminderServiceImpl) {
        yield* requireValidAgentId(agentId, ReminderGuardrailViolation);
        const fs = yield* FileSystem.FileSystem;
        const filePath = reminderFilePath(this.baseReminderDirectory, agentId);
        return yield* readReminderFile(fs, filePath);
      }.bind(this),
    );

  readonly cancel: ReminderService["cancel"] = (agentId, id) =>
    this.withValidatedAgentLock(
      agentId,
      Effect.gen(
        function* (this: ReminderServiceImpl) {
          const fs = yield* FileSystem.FileSystem;
          const filePath = reminderFilePath(this.baseReminderDirectory, agentId);
          const existing = yield* readReminderFile(fs, filePath);
          const remaining = existing.filter((reminder) => reminder.id !== id);

          if (remaining.length === existing.length) {
            return {
              success: false,
              message: `No reminder found with id "${id}".`,
            } satisfies CancelReminderOutcome;
          }

          yield* writeFileStringAtomic(fs, filePath, `${JSON.stringify(remaining, null, 2)}\n`, {
            tempPrefix: "reminders",
          });
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
 * Scan every `<agentId>.json` file under `baseReminderDirectory`, remove
 * reminders whose `fireAt` has passed, and return them grouped by agentId.
 *
 * Callable from plain async code (e.g. the Telegram bridge's `setInterval`
 * sweep) via a single `Effect.runPromise` at the one call site — this keeps
 * every read-modify-write of a reminder file going through the same
 * `withLock` mechanism as `add`/`cancel`, so the plain-Node sweep loop and the
 * Effect-based tool handlers never race on the same file.
 */
export function sweepDueReminders(
  baseReminderDirectory: string,
  now: number,
): Effect.Effect<
  ReadonlyArray<{ agentId: string; reminder: ReminderRecord }>,
  Error,
  FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directoryExists = yield* fs
      .exists(baseReminderDirectory)
      .pipe(Effect.catchAll(() => Effect.succeed(false)));
    if (!directoryExists) return [];

    const names = yield* fs
      .readDirectory(baseReminderDirectory)
      .pipe(Effect.catchAll(() => Effect.succeed<string[]>([])));
    const agentIds = names
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length));

    const fired: Array<{ agentId: string; reminder: ReminderRecord }> = [];

    for (const agentId of agentIds) {
      const filePath = reminderFilePath(baseReminderDirectory, agentId);
      const lockPath = reminderLockPath(baseReminderDirectory, agentId);

      const dueForAgent = yield* withLock(
        lockPath,
        Effect.gen(function* () {
          const reminders = yield* readReminderFile(fs, filePath);
          const due = reminders.filter((reminder) => reminder.fireAt <= now);
          if (due.length === 0) return [] as ReminderRecord[];

          const remaining = reminders.filter((reminder) => reminder.fireAt > now);
          yield* writeFileStringAtomic(fs, filePath, `${JSON.stringify(remaining, null, 2)}\n`, {
            tempPrefix: "reminders",
          });
          return due;
        }),
        // A file whose lock can't be acquired this sweep will simply be
        // retried on the next tick — never let one stuck agent block the rest.
      ).pipe(Effect.catchAll(() => Effect.succeed([] as ReminderRecord[])));

      for (const reminder of dueForAgent) {
        fired.push({ agentId, reminder });
      }
    }

    return fired;
  });
}
