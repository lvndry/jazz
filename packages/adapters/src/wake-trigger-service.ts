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
import { WakeTriggerServiceTag } from "@jazz/core/interfaces/wake-trigger-service";
import { getJazzHomeDirectory } from "@jazz/core/utils/paths";
import { requireValidAgentId, withLock, writeFileStringAtomic } from "@jazz/core/utils/storage";
import { parseWhen } from "@jazz/core/utils/time";
import { Effect, Layer } from "effect";

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

function readWakeTriggerFile(
  fs: FileSystem.FileSystem,
  filePath: string,
): Effect.Effect<WakeTriggerRecord[], Error> {
  return Effect.gen(function* () {
    const exists = yield* fs.exists(filePath).pipe(Effect.catchAll(() => Effect.succeed(false)));
    if (!exists) return [];

    const content = yield* fs
      .readFileString(filePath)
      .pipe(Effect.catchAll((e) => Effect.fail(e instanceof Error ? e : new Error(String(e)))));

    try {
      const parsed = JSON.parse(content) as unknown;
      return Array.isArray(parsed) ? (parsed as WakeTriggerRecord[]) : [];
    } catch {
      return [];
    }
  });
}

export interface WakeTriggerServiceImplOptions {
  /** Override for tests; defaults to ~/.jazz/wake-triggers (or $JAZZ_HOME/wake-triggers). */
  readonly baseWakeTriggerDirectory?: string;
}

export class WakeTriggerServiceImpl implements WakeTriggerService {
  private readonly baseWakeTriggerDirectory: string;

  constructor(options?: WakeTriggerServiceImplOptions) {
    this.baseWakeTriggerDirectory =
      options?.baseWakeTriggerDirectory ?? path.join(getJazzHomeDirectory(), "wake-triggers");
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
        .makeDirectory(baseWakeTriggerDirectory, { recursive: true })
        .pipe(Effect.catchAll((e) => Effect.fail(e instanceof Error ? e : new Error(String(e)))));
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
          const fs = yield* FileSystem.FileSystem;
          const filePath = wakeTriggerFilePath(this.baseWakeTriggerDirectory, agentId);
          const existing = yield* readWakeTriggerFile(fs, filePath);

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
          if (existing.length >= MAX_WAKE_TRIGGERS_PER_AGENT) {
            return yield* Effect.fail(
              new WakeTriggerGuardrailViolation(
                `You already have ${existing.length} pending wake triggers, the maximum of ${MAX_WAKE_TRIGGERS_PER_AGENT}. Cancel one with cancel_trigger before registering another.`,
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

          const trigger: WakeTriggerRecord = {
            id: newWakeTriggerId(),
            fireAt,
            conversationId,
            prompt,
            reason,
            createdAt: now,
          };
          yield* writeFileStringAtomic(
            fs,
            filePath,
            `${JSON.stringify([...existing, trigger], null, 2)}\n`,
            { tempPrefix: "wake-triggers" },
          );

          return { success: true, trigger } satisfies AddWakeTriggerOutcome;
        }.bind(this),
      ),
    );

  readonly list: WakeTriggerService["list"] = (agentId) =>
    Effect.gen(
      function* (this: WakeTriggerServiceImpl) {
        yield* requireValidAgentId(agentId, WakeTriggerGuardrailViolation);
        const fs = yield* FileSystem.FileSystem;
        const filePath = wakeTriggerFilePath(this.baseWakeTriggerDirectory, agentId);
        return yield* readWakeTriggerFile(fs, filePath);
      }.bind(this),
    );

  readonly cancel: WakeTriggerService["cancel"] = (agentId, id) =>
    this.withValidatedAgentLock(
      agentId,
      Effect.gen(
        function* (this: WakeTriggerServiceImpl) {
          const fs = yield* FileSystem.FileSystem;
          const filePath = wakeTriggerFilePath(this.baseWakeTriggerDirectory, agentId);
          const existing = yield* readWakeTriggerFile(fs, filePath);
          const remaining = existing.filter((trigger) => trigger.id !== id);

          if (remaining.length === existing.length) {
            return {
              success: false,
              message: `No wake trigger found with id "${id}".`,
            } satisfies CancelWakeTriggerOutcome;
          }

          yield* writeFileStringAtomic(fs, filePath, `${JSON.stringify(remaining, null, 2)}\n`, {
            tempPrefix: "wake-triggers",
          });
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
 * Scan every `<agentId>.json` file under `baseWakeTriggerDirectory`, remove triggers whose
 * `fireAt` has passed, and return them grouped by agentId — the same shape and locking
 * discipline as `sweepDueReminders`, so the daemon's ticker and the tool handlers never race
 * on the same file.
 */
export function sweepDueWakeTriggers(
  baseWakeTriggerDirectory: string,
  now: number,
): Effect.Effect<
  ReadonlyArray<{ agentId: string; trigger: WakeTriggerRecord }>,
  Error,
  FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directoryExists = yield* fs
      .exists(baseWakeTriggerDirectory)
      .pipe(Effect.catchAll(() => Effect.succeed(false)));
    if (!directoryExists) return [];

    const names = yield* fs
      .readDirectory(baseWakeTriggerDirectory)
      .pipe(Effect.catchAll(() => Effect.succeed<string[]>([])));
    const agentIds = names
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length));

    const fired: Array<{ agentId: string; trigger: WakeTriggerRecord }> = [];

    for (const agentId of agentIds) {
      const filePath = wakeTriggerFilePath(baseWakeTriggerDirectory, agentId);
      const lockPath = wakeTriggerLockPath(baseWakeTriggerDirectory, agentId);

      const dueForAgent = yield* withLock(
        lockPath,
        Effect.gen(function* () {
          const triggers = yield* readWakeTriggerFile(fs, filePath);
          const due = triggers.filter((trigger) => trigger.fireAt <= now);
          if (due.length === 0) return [] as WakeTriggerRecord[];

          const remaining = triggers.filter((trigger) => trigger.fireAt > now);
          yield* writeFileStringAtomic(fs, filePath, `${JSON.stringify(remaining, null, 2)}\n`, {
            tempPrefix: "wake-triggers",
          });
          return due;
        }),
        // A file whose lock can't be acquired this sweep is retried next tick — one stuck
        // agent never blocks the rest.
      ).pipe(Effect.catchAll(() => Effect.succeed([] as WakeTriggerRecord[])));

      for (const trigger of dueForAgent) {
        fired.push({ agentId, trigger });
      }
    }

    return fired;
  });
}
