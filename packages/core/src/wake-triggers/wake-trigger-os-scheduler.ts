/**
 * `WakeTriggerOsScheduler`: installs one real OS-level job per wake trigger (launchd on macOS,
 * a one-shot `at` job on Linux) so a trigger fires even when `jazz daemon`'s in-process ticker
 * isn't running. Mirrors `SchedulerService` (`../workflows/scheduler-service`), which does the
 * same thing for scheduled workflows — the difference is shape: a workflow schedule is
 * recurring (cron), a wake trigger is a single `fireAt` instant, which is why this uses `at`
 * rather than cron on Linux. Cron has no year field and cannot express a genuine one-shot
 * without a follow-up job to remove itself; `at` already is a one-shot primitive.
 *
 * The actual OS-job mechanics (plist building, launchd load/unload, `at` scheduling, platform
 * detection) live in `./one-shot-os-job`, shared with `reminder-os-scheduler.ts` — a wake
 * trigger and a reminder are both "run one jazz command at a future instant," differing only in
 * what that command does once invoked.
 *
 * Scheduling here is a best-effort reliability upgrade layered on top of the JSON record that
 * `WakeTriggerServiceImpl` writes, not a replacement for it: a scheduling failure must never
 * block registering a trigger, and the in-process ticker (`runDueTriggers`) remains the
 * fallback for hosts with neither launchd nor `at`.
 */
import { Context, Effect, Layer } from "effect";
import { createOneShotOsScheduler } from "./one-shot-os-job";

export interface ScheduleFireResult {
  readonly osSchedulerJobId?: string;
}

export interface WakeTriggerOsScheduler {
  readonly getType: () => "launchd" | "at" | "in-process" | "unsupported";
  readonly scheduleFire: (
    agentId: string,
    triggerId: string,
    fireAt: number,
  ) => Effect.Effect<ScheduleFireResult, Error>;
  readonly cancelFire: (
    agentId: string,
    triggerId: string,
    osSchedulerJobId: string | undefined,
  ) => Effect.Effect<void, Error>;
}

export const WakeTriggerOsSchedulerTag =
  Context.GenericTag<WakeTriggerOsScheduler>("WakeTriggerOsScheduler");

function buildFireArgs(agentId: string, triggerId: string): readonly string[] {
  return ["--output", "quiet", "wake-trigger", "fire", "--agent", agentId, "--id", triggerId];
}

/**
 * Create the appropriate `WakeTriggerOsScheduler` for the current platform and configuration.
 *
 * Never throws and never blocks: an unavailable `at` binary, or any other detection failure,
 * falls back to the in-process scheduler rather than failing trigger registration.
 */
export function createWakeTriggerOsScheduler(): Effect.Effect<WakeTriggerOsScheduler> {
  return createOneShotOsScheduler({
    labelPrefix: "com.jazz.trigger",
    logNamePrefix: "wake-trigger",
    buildProgramArgs: buildFireArgs,
  });
}

export const WakeTriggerOsSchedulerLayer = Layer.effect(
  WakeTriggerOsSchedulerTag,
  createWakeTriggerOsScheduler(),
);
