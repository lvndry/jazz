/**
 * `ReminderOsScheduler`: installs one real OS-level job per reminder (launchd on macOS, a
 * one-shot `at` job on Linux) so a reminder fires even when nothing else is watching for it —
 * the CLI-hosted-agent equivalent of `WakeTriggerOsScheduler`. Firing means something different
 * here, though: a reminder is "notify a person," never "resume the agent" (see
 * `wake-trigger-tools.ts`'s file comment for that distinction), so `jazz reminder fire` sends a
 * native OS desktop notification instead of re-entering the agent loop.
 *
 * This is only ever wired up for reminders whose `agentId` does not start with `tg_`/`dc_` —
 * see `reminder-service.ts` for why: Telegram and Discord already sweep and deliver their own
 * reminders in-process, and installing an OS job here too would double-deliver.
 *
 * Shares its OS-job mechanics with `wake-trigger-os-scheduler.ts` via `./one-shot-os-job`.
 */
import { Context, Effect, Layer } from "effect";
import { createOneShotOsScheduler } from "./one-shot-os-job";

export interface ReminderScheduleFireResult {
  readonly osSchedulerJobId?: string;
}

export interface ReminderOsScheduler {
  readonly getType: () => "launchd" | "at" | "in-process" | "unsupported";
  readonly scheduleFire: (
    agentId: string,
    reminderId: string,
    fireAt: number,
  ) => Effect.Effect<ReminderScheduleFireResult, Error>;
  readonly cancelFire: (
    agentId: string,
    reminderId: string,
    osSchedulerJobId: string | undefined,
  ) => Effect.Effect<void, Error>;
}

export const ReminderOsSchedulerTag =
  Context.GenericTag<ReminderOsScheduler>("ReminderOsScheduler");

function buildFireArgs(agentId: string, reminderId: string): readonly string[] {
  return ["--output", "quiet", "reminder", "fire", "--agent", agentId, "--id", reminderId];
}

/**
 * Create the appropriate `ReminderOsScheduler` for the current platform and configuration.
 *
 * Never throws and never blocks: an unavailable `at` binary, or any other detection failure,
 * falls back to the in-process scheduler rather than failing reminder registration.
 */
export function createReminderOsScheduler(): Effect.Effect<ReminderOsScheduler> {
  return createOneShotOsScheduler({
    labelPrefix: "com.jazz.reminder",
    logNamePrefix: "reminder",
    buildProgramArgs: buildFireArgs,
  });
}

export const ReminderOsSchedulerLayer = Layer.effect(
  ReminderOsSchedulerTag,
  createReminderOsScheduler(),
);
