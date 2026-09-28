/**
 * @fileoverview Firing due workflow schedules, self-registered wake triggers, reminders and
 * background jobs, on a plain interval, from inside `jazz daemon`.
 *
 * This is the daemon's alternative to depending on `launchd`/`crontab` existing on the host.
 * A tick only claims work: each claim is a short locked read-modify-write, and the work it
 * claimed (a workflow run, an agent turn, a notification, a job drain) is forked, so a
 * 30-minute workflow never delays a reminder. {@link forkOnce} keeps one fiber per unit of
 * work, so a slow drain is not started twice by later ticks.
 *
 * Reminders and wake triggers are delivered at least once: the record is claimed before the
 * effect, removed only after it succeeded, and kept with the error and a retry time when it
 * failed (see `delivery.ts` in core). Each tick also drains the notify outbox and compacts the
 * spend ledger's finished days.
 */

import { runDueDetachedJobs } from "@jazz/adapters/detach/job";
import { sendDesktopNotification } from "@jazz/adapters/notification/desktop-notifier";
import { drainNotifyOutbox } from "@jazz/adapters/notification/outbox-drain";
import {
  claimDueReminders,
  isBotHostedAgentId,
  settleReminder,
} from "@jazz/adapters/reminder-service";
import type { ScheduledItemClaim } from "@jazz/adapters/storage/scheduled-items";
import { claimDueWakeTriggers, settleWakeTrigger } from "@jazz/adapters/wake-trigger-service";
import { AgentConfigServiceTag } from "@jazz/core/interfaces/agent-config";
import type { ReminderRecord } from "@jazz/core/interfaces/reminder-service";
import type { WakeTriggerRecord } from "@jazz/core/interfaces/wake-trigger-service";
import { enqueueNotification, notifyTargets } from "@jazz/core/notify/outbox";
import { compactSpendLedger } from "@jazz/core/spend/ledger";
import type { DeliveryOutcome } from "@jazz/core/utils/delivery";
import { getJazzHomeDirectory } from "@jazz/core/utils/paths";
import {
  createReminderOsScheduler,
  type ReminderOsScheduler,
} from "@jazz/core/wake-triggers/reminder-os-scheduler";
import {
  createWakeTriggerOsScheduler,
  type WakeTriggerOsScheduler,
} from "@jazz/core/wake-triggers/wake-trigger-os-scheduler";
import {
  claimInProcessScheduledWorkflows,
  type ClaimedWorkflowRun,
  runClaimedWorkflow,
} from "@jazz/core/workflows/catch-up";
import { Cause, Effect, Exit } from "effect";
import { runDueJobs } from "@/daemon/job-worker";
import { runUnattendedTurn } from "@/daemon/unattended-resume";

export function wakeTriggerDirectory(): string {
  return `${getJazzHomeDirectory()}/wake-triggers`;
}

export function reminderDirectory(): string {
  return `${getJazzHomeDirectory()}/reminders`;
}

/**
 * How late a wake trigger may fire and still be announced as on time: the daemon ticks every
 * few seconds and the host scheduler fires on the minute, so anything under this is ordinary.
 */
const ON_TIME_TOLERANCE_MS = 2 * 60_000;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

function formatLateness(lateMs: number): string {
  if (lateMs < HOUR_MS) {
    return `${Math.round(lateMs / MINUTE_MS)} minutes late`;
  }
  const hours = Math.floor(lateMs / HOUR_MS);
  const minutes = Math.round((lateMs % HOUR_MS) / MINUTE_MS);
  return minutes === 0 ? `${hours} hours late` : `${hours} hours ${minutes} minutes late`;
}

/**
 * The turn a wake trigger starts: when it was scheduled for, when it actually fired and how
 * late that is, then the agent's own prompt. After a laptop sleeps, a "leave for the airport at
 * 9:00" trigger that fires at 18:00 must not read as if it were on time.
 */
export function wakeTriggerTurnPrompt(
  trigger: Pick<WakeTriggerRecord, "fireAt" | "prompt">,
  firedAt: number,
): string {
  const lateMs = firedAt - trigger.fireAt;
  const timing = lateMs > ON_TIME_TOLERANCE_MS ? formatLateness(lateMs) : "on time";
  return (
    `[Wake trigger scheduled for ${new Date(trigger.fireAt).toISOString()}, firing at ` +
    `${new Date(firedAt).toISOString()} (${timing}).]\n\n${trigger.prompt}`
  );
}

function outcomeOfExit(exit: Exit.Exit<DeliveryOutcome, unknown>): DeliveryOutcome {
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  return { delivered: false, error: Cause.pretty(exit.cause), retryable: true };
}

/**
 * Run a claimed wake trigger's turn and settle the claim: removed when the turn finished or
 * parked, kept with the error (and retried with backoff) when it failed.
 */
export function deliverWakeTrigger(agentId: string, trigger: WakeTriggerRecord) {
  return Effect.gen(function* () {
    const exit = yield* runUnattendedTurn({
      agentId,
      conversationId: trigger.conversationId,
      prompt: wakeTriggerTurnPrompt(trigger, Date.now()),
      fallbackTitle: trigger.prompt,
      source: "wake trigger",
      sourceId: trigger.id,
    }).pipe(Effect.exit);
    yield* settleWakeTrigger(wakeTriggerDirectory(), agentId, trigger.id, outcomeOfExit(exit));
  });
}

/** What a reminder records when it could be shown neither on the desktop nor on a notify target. */
function reminderUndeliverable(desktopError: string): string {
  return `No desktop notification could be shown (${desktopError}), and no notify target takes reminders.`;
}

/**
 * Deliver a claimed reminder and settle the claim. The desktop comes first; when nothing can be
 * shown there (a headless host, a system service with no desktop session), the reminder is
 * handed to every notify target that takes reminders. The outbox retries a target that is
 * down, so a reminder handed over is delivered. With no desktop and no target, the reminder
 * stays on disk as failed with that reason instead of being consumed unseen.
 */
export function deliverReminder(agentId: string, reminder: ReminderRecord) {
  return Effect.gen(function* () {
    const desktop = yield* sendDesktopNotification({
      title: "Jazz reminder",
      message: reminder.text,
    });
    const handedOff = desktop.delivered ? false : yield* handReminderToTargets(agentId, reminder);
    const outcome: DeliveryOutcome =
      desktop.delivered || handedOff
        ? { delivered: true }
        : { delivered: false, error: reminderUndeliverable(desktop.error), retryable: true };
    const settled = yield* settleReminder(reminderDirectory(), agentId, reminder.id, outcome);
    if (handedOff) {
      yield* drainNotifyOutbox();
    }
    return settled;
  });
}

function handReminderToTargets(agentId: string, reminder: ReminderRecord) {
  return Effect.gen(function* () {
    const config = yield* AgentConfigServiceTag;
    const appConfig = yield* config.appConfig;
    const result = yield* enqueueNotification(
      notifyTargets(appConfig),
      { kind: "reminder", agentId, text: reminder.text, fireAt: reminder.fireAt },
      { excludeKinds: ["desktop"] },
    ).pipe(
      Effect.catchAll((error) =>
        Effect.sync(() => {
          process.stderr.write(
            `[jazz] Could not queue a reminder notification: ${error.message}\n`,
          );
          return { queued: [] as readonly string[] };
        }),
      ),
    );
    return result.queued.length > 0;
  });
}

const workInFlight = new Set<string>();

/**
 * Fork `work` as a daemon fiber unless a fiber for `key` is still running, and return at once.
 * The key is released when the work ends, however it ends.
 */
export function forkOnce<R>(key: string, work: Effect.Effect<void, never, R>) {
  return Effect.suspend(() => {
    if (workInFlight.has(key)) {
      return Effect.void;
    }
    workInFlight.add(key);
    return work.pipe(
      Effect.ensuring(Effect.sync(() => workInFlight.delete(key))),
      Effect.forkDaemon,
      Effect.asVoid,
    );
  });
}

function reportFailure(work: string) {
  return (cause: Cause.Cause<unknown>) =>
    Effect.sync(() => {
      process.stderr.write(`jazz daemon ${work} failed: ${Cause.pretty(cause)}\n`);
    });
}

let wakeTriggerOsScheduler: WakeTriggerOsScheduler | undefined;
let reminderOsScheduler: ReminderOsScheduler | undefined;

function osSchedulers() {
  return Effect.gen(function* () {
    wakeTriggerOsScheduler ??= yield* createWakeTriggerOsScheduler();
    reminderOsScheduler ??= yield* createReminderOsScheduler();
    return { wakeTrigger: wakeTriggerOsScheduler, reminder: reminderOsScheduler };
  });
}

/**
 * What one tick does, as separate steps: claim, then run each claim. Split out so the tick's
 * scheduling (claims first, work forked) can be exercised with stand-in work.
 */
export interface TickWork<R> {
  readonly claimWorkflows: Effect.Effect<readonly ClaimedWorkflowRun[], unknown, R>;
  readonly runWorkflow: (claim: ClaimedWorkflowRun) => Effect.Effect<void, unknown, R>;
  readonly claimWakeTriggers: (
    now: number,
  ) => Effect.Effect<ReadonlyArray<ScheduledItemClaim<WakeTriggerRecord>>, unknown, R>;
  readonly deliverWakeTrigger: (
    agentId: string,
    trigger: WakeTriggerRecord,
  ) => Effect.Effect<void, unknown, R>;
  readonly claimReminders: (
    now: number,
  ) => Effect.Effect<ReadonlyArray<ScheduledItemClaim<ReminderRecord>>, unknown, R>;
  readonly deliverReminder: (
    agentId: string,
    reminder: ReminderRecord,
  ) => Effect.Effect<void, unknown, R>;
  readonly drainDetachedJobs: Effect.Effect<void, unknown, R>;
  readonly drainJobBatches: Effect.Effect<void, unknown, R>;
  readonly drainNotifications: Effect.Effect<void, unknown, R>;
  readonly compactSpendLedger: Effect.Effect<void, unknown, R>;
}

/** The daemon's real tick work. */
export const daemonTickWork = {
  claimWorkflows: claimInProcessScheduledWorkflows(),
  runWorkflow: runClaimedWorkflow,
  claimWakeTriggers: (now: number) =>
    osSchedulers().pipe(
      Effect.flatMap((schedulers) =>
        claimDueWakeTriggers(wakeTriggerDirectory(), now, { osScheduler: schedulers.wakeTrigger }),
      ),
    ),
  deliverWakeTrigger,
  // Fallback for hosts with neither launchd nor `at`: the reliability upgrade in
  // `reminder-os-scheduler.ts` is best-effort, so this ticker still needs to catch anything
  // it missed. Bot-hosted reminders are never claimed here: their own bridge delivers them.
  claimReminders: (now: number) =>
    osSchedulers().pipe(
      Effect.flatMap((schedulers) =>
        claimDueReminders(reminderDirectory(), now, {
          includeAgent: (agentId) => !isBotHostedAgentId(agentId),
          osScheduler: schedulers.reminder,
        }),
      ),
    ),
  deliverReminder: (agentId: string, reminder: ReminderRecord) =>
    deliverReminder(agentId, reminder).pipe(Effect.asVoid),
  drainDetachedJobs: runDueDetachedJobs(),
  drainJobBatches: runDueJobs(),
  drainNotifications: drainNotifyOutbox().pipe(Effect.asVoid),
  compactSpendLedger: compactSpendLedger(),
};

export interface TickOptions {
  readonly runWorkflows?: boolean;
  /**
   * False while the daemon is paused (by the user or at the daily cap): only reminders, which
   * run nothing, are delivered, and wake triggers, workflows and jobs stay unclaimed and due
   * until it resumes.
   */
  readonly startNew?: boolean;
}

/**
 * One tick: claim due workflow slots, wake triggers and reminders, and fork each claimed unit
 * of work; start (once) the detached-job and job-batch drains. Never waits for the work, so a
 * slow workflow cannot delay a reminder.
 *
 * Claim failures are reported and swallowed: a stuck lock or a transient error must never stop
 * the ticker from running on the next interval.
 */
export function runTick<R>(options: TickOptions, work: TickWork<R>) {
  return Effect.gen(function* () {
    const startNew = options.startNew !== false;
    if (startNew && options.runWorkflows === true) {
      const claims = yield* work.claimWorkflows.pipe(
        Effect.catchAllCause((cause) =>
          reportFailure("workflow claim")(cause).pipe(
            Effect.as([] as readonly ClaimedWorkflowRun[]),
          ),
        ),
      );
      for (const claim of claims) {
        yield* forkOnce(
          `workflow:${claim.record.id}`,
          work.runWorkflow(claim).pipe(Effect.catchAllCause(reportFailure("workflow run"))),
        );
      }
    }

    const now = Date.now();
    // Claiming takes a trigger for firing, so a paused daemon leaves due triggers unclaimed.
    const wakeClaims = yield* (startNew ? work.claimWakeTriggers(now) : Effect.succeed([])).pipe(
      Effect.catchAllCause((cause) =>
        reportFailure("wake trigger claim")(cause).pipe(Effect.as([])),
      ),
    );
    for (const { agentId, item } of wakeClaims) {
      yield* forkOnce(
        `wake trigger:${agentId}:${item.id}`,
        work
          .deliverWakeTrigger(agentId, item)
          .pipe(Effect.catchAllCause(reportFailure("wake trigger"))),
      );
    }

    const reminderClaims = yield* work
      .claimReminders(now)
      .pipe(
        Effect.catchAllCause((cause) => reportFailure("reminder claim")(cause).pipe(Effect.as([]))),
      );
    for (const { agentId, item } of reminderClaims) {
      yield* forkOnce(
        `reminder:${agentId}:${item.id}`,
        work.deliverReminder(agentId, item).pipe(Effect.catchAllCause(reportFailure("reminder"))),
      );
    }

    // Telling the person and keeping the books are not new work: a paused daemon still sends
    // what it queued (including the notice that it paused) and compacts the ledger.
    yield* forkOnce(
      "notifications",
      work.drainNotifications.pipe(Effect.catchAllCause(reportFailure("notifications"))),
    );
    yield* forkOnce(
      "spend ledger",
      work.compactSpendLedger.pipe(Effect.catchAllCause(reportFailure("spend ledger compaction"))),
    );
    if (!startNew) {
      return;
    }
    yield* forkOnce(
      "detached jobs",
      work.drainDetachedJobs.pipe(Effect.catchAllCause(reportFailure("detached jobs"))),
    );
    yield* forkOnce(
      "job batches",
      work.drainJobBatches.pipe(Effect.catchAllCause(reportFailure("jobs"))),
    );
  });
}

type RequirementsOf<Step> =
  Step extends Effect.Effect<unknown, unknown, infer Requirements>
    ? Requirements
    : Step extends (...args: never[]) => Effect.Effect<unknown, unknown, infer Requirements>
      ? Requirements
      : never;

/** Every service the daemon's real tick work needs. */
type DaemonTickRequirements = {
  readonly [Step in keyof typeof daemonTickWork]: RequirementsOf<(typeof daemonTickWork)[Step]>;
}[keyof typeof daemonTickWork];

/** One daemon tick with the real work; see {@link runTick}. */
export function runDueTriggers(options: TickOptions = {}) {
  return runTick<DaemonTickRequirements>(options, daemonTickWork);
}
