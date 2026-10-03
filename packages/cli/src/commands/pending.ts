/**
 * @fileoverview `jazz reminders`, `jazz triggers` and `jazz jobs`: see and cancel what is
 * waiting to happen while nobody is watching.
 *
 * Agents register these themselves (`remind_me`, `register_trigger`, `run_background_jobs`), so
 * without a command the person the work is for cannot see what is queued or stop it. Each
 * noun has `list` (every agent, or `--agent` for one; `--json` for one envelope on stdout)
 * and `cancel <id>`, which finds the id across agents unless `--agent` narrows it. Cancelling
 * goes through the same service calls the agent's own cancel tools use, so the host
 * scheduler's job is removed with the record.
 *
 * The plural names are the person's commands. The singular `jazz reminder`, `jazz
 * wake-trigger` and `jazz job` are what the host scheduler and the job worker invoke.
 */

import { getAgentByIdentifier } from "@jazz/core/agent/agent-service";
import { AgentServiceTag } from "@jazz/core/interfaces/agent-service";
import type { JobBatchRecord } from "@jazz/core/interfaces/job-queue-service";
import { JobQueueServiceTag } from "@jazz/core/interfaces/job-queue-service";
import type { ReminderRecord } from "@jazz/core/interfaces/reminder-service";
import { ReminderServiceTag } from "@jazz/core/interfaces/reminder-service";
import type { WakeTriggerRecord } from "@jazz/core/interfaces/wake-trigger-service";
import { WakeTriggerServiceTag } from "@jazz/core/interfaces/wake-trigger-service";
import { toError } from "@jazz/core/utils/errors";
import { Effect } from "effect";
import { emitEnvelope, failEnvelope } from "@/cli/helpers/json-output";

interface AgentRef {
  readonly id: string;
  readonly name: string;
}

/** The agents to look in: the one `--agent` names, or all of them. */
function agentsToSearch(agent: string | undefined) {
  return Effect.gen(function* () {
    if (agent !== undefined) {
      const found = yield* getAgentByIdentifier(agent.trim());
      return [{ id: found.id, name: found.name }] as readonly AgentRef[];
    }
    const agentService = yield* AgentServiceTag;
    const agents = yield* agentService.listAgents();
    return agents.map((found) => ({ id: found.id, name: found.name }));
  });
}

/** `in 2h 5m` or `5m ago`, relative to `now`. */
export function describeWhen(fireAt: number, now: number = Date.now()): string {
  const deltaMs = fireAt - now;
  const minutes = Math.round(Math.abs(deltaMs) / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const span =
    days > 0
      ? `${String(days)}d ${String(hours % 24)}h`
      : hours > 0
        ? `${String(hours)}h ${String(minutes % 60)}m`
        : `${String(minutes)}m`;
  const local = new Date(fireAt).toLocaleString();
  return deltaMs >= 0 ? `${local} (in ${span})` : `${local} (${span} ago, due)`;
}

export interface PendingReminder {
  readonly agentId: string;
  readonly agentName: string;
  readonly id: string;
  readonly fireAt: string;
  readonly text: string;
}

export interface PendingTrigger {
  readonly agentId: string;
  readonly agentName: string;
  readonly id: string;
  readonly fireAt: string;
  readonly conversationId: string;
  readonly reason: string;
  readonly prompt: string;
}

export interface PendingBatch {
  readonly agentId: string;
  readonly agentName: string;
  readonly id: string;
  readonly reason: string;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly jobs: Readonly<Record<string, number>>;
}

function toPendingReminder(agent: AgentRef, reminder: ReminderRecord): PendingReminder {
  return {
    agentId: agent.id,
    agentName: agent.name,
    id: reminder.id,
    fireAt: new Date(reminder.fireAt).toISOString(),
    text: reminder.text,
  };
}

function toPendingTrigger(agent: AgentRef, trigger: WakeTriggerRecord): PendingTrigger {
  return {
    agentId: agent.id,
    agentName: agent.name,
    id: trigger.id,
    fireAt: new Date(trigger.fireAt).toISOString(),
    conversationId: trigger.conversationId,
    reason: trigger.reason,
    prompt: trigger.prompt,
  };
}

/** Job counts by status, e.g. `{ succeeded: 2, running: 1 }`. */
function countJobs(batch: JobBatchRecord): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const job of batch.jobs) {
    counts[job.status] = (counts[job.status] ?? 0) + 1;
  }
  return counts;
}

function toPendingBatch(agent: AgentRef, batch: JobBatchRecord): PendingBatch {
  return {
    agentId: agent.id,
    agentName: agent.name,
    id: batch.id,
    reason: batch.reason,
    createdAt: new Date(batch.createdAt).toISOString(),
    completedAt: batch.completedAt === null ? null : new Date(batch.completedAt).toISOString(),
    jobs: countJobs(batch),
  };
}

/** Every agent's reminders, soonest first. */
export function collectReminders(agent?: string) {
  return Effect.gen(function* () {
    const reminderService = yield* ReminderServiceTag;
    const found: PendingReminder[] = [];
    for (const candidate of yield* agentsToSearch(agent)) {
      const reminders = yield* reminderService.list(candidate.id);
      found.push(...reminders.map((reminder) => toPendingReminder(candidate, reminder)));
    }
    return found.sort((left, right) => left.fireAt.localeCompare(right.fireAt));
  });
}

/** Every agent's wake triggers, soonest first. */
export function collectTriggers(agent?: string) {
  return Effect.gen(function* () {
    const wakeTriggerService = yield* WakeTriggerServiceTag;
    const found: PendingTrigger[] = [];
    for (const candidate of yield* agentsToSearch(agent)) {
      const triggers = yield* wakeTriggerService.list(candidate.id);
      found.push(...triggers.map((trigger) => toPendingTrigger(candidate, trigger)));
    }
    return found.sort((left, right) => left.fireAt.localeCompare(right.fireAt));
  });
}

/**
 * Every agent's job batches that are still in the active directory, newest first: the ones
 * running, and finished ones not yet archived.
 */
export function collectBatches(agent?: string) {
  return Effect.gen(function* () {
    const jobQueueService = yield* JobQueueServiceTag;
    const found: PendingBatch[] = [];
    for (const candidate of yield* agentsToSearch(agent)) {
      const batches = yield* jobQueueService.listActiveBatches(candidate.id);
      found.push(...batches.map((batch) => toPendingBatch(candidate, batch)));
    }
    return found.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  });
}

export function formatReminders(reminders: readonly PendingReminder[], now = Date.now()): string {
  if (reminders.length === 0) {
    return "No reminders are waiting.";
  }
  return reminders
    .map(
      (reminder) =>
        `${reminder.id}  ${describeWhen(Date.parse(reminder.fireAt), now)}  [${reminder.agentName}]\n` +
        `    ${reminder.text}`,
    )
    .join("\n");
}

export function formatTriggers(triggers: readonly PendingTrigger[], now = Date.now()): string {
  if (triggers.length === 0) {
    return "No wake triggers are waiting.";
  }
  return triggers
    .map(
      (trigger) =>
        `${trigger.id}  ${describeWhen(Date.parse(trigger.fireAt), now)}  [${trigger.agentName}]\n` +
        `    ${trigger.reason.length > 0 ? trigger.reason : trigger.prompt}`,
    )
    .join("\n");
}

export function formatBatches(batches: readonly PendingBatch[]): string {
  if (batches.length === 0) {
    return "No job batches are active.";
  }
  return batches
    .map((batch) => {
      const counts = Object.entries(batch.jobs)
        .map(([status, count]) => `${String(count)} ${status}`)
        .join(", ");
      const state = batch.completedAt === null ? "active" : "finished";
      return (
        `${batch.id}  ${state}  [${batch.agentName}]  started ${new Date(batch.createdAt).toLocaleString()}\n` +
        `    ${batch.reason}  (${counts})`
      );
    })
    .join("\n");
}

function listCommand<Item, Requirements>(
  options: { readonly json: boolean },
  collect: Effect.Effect<readonly Item[], unknown, Requirements>,
  key: string,
  format: (items: readonly Item[]) => string,
) {
  return collect.pipe(
    Effect.map((items) => {
      emitEnvelope(options.json, { ok: true, [key]: items }, format(items));
    }),
    Effect.catchAll((error) =>
      Effect.sync(() => failEnvelope(options.json, toError(error).message)),
    ),
  );
}

export interface ListPendingOptions {
  readonly agent?: string | undefined;
  readonly json: boolean;
}

export function listRemindersCommand(options: ListPendingOptions) {
  return listCommand(options, collectReminders(options.agent), "reminders", (items) =>
    formatReminders(items),
  );
}

export function listTriggersCommand(options: ListPendingOptions) {
  return listCommand(options, collectTriggers(options.agent), "triggers", (items) =>
    formatTriggers(items),
  );
}

export function listJobsCommand(options: ListPendingOptions) {
  return listCommand(options, collectBatches(options.agent), "batches", formatBatches);
}

interface CancelOptions {
  readonly id: string;
  readonly agent?: string | undefined;
}

/** Cancels `options.id` in the first agent that holds it, via `cancelIn`. */
function cancelCommand<Requirements>(
  options: CancelOptions,
  noun: string,
  holds: (agent: AgentRef) => Effect.Effect<boolean, unknown, Requirements>,
  cancelIn: (
    agent: AgentRef,
  ) => Effect.Effect<
    { readonly success: boolean; readonly message: string },
    unknown,
    Requirements
  >,
) {
  return Effect.gen(function* () {
    const agents = yield* agentsToSearch(options.agent);
    for (const candidate of agents) {
      if (!(yield* holds(candidate))) {
        continue;
      }
      const outcome = yield* cancelIn(candidate);
      if (outcome.success) {
        process.stdout.write(`${outcome.message}\n`);
      } else {
        failEnvelope(false, outcome.message);
      }
      return;
    }
    failEnvelope(false, `No ${noun} with id "${options.id}".`);
  }).pipe(
    Effect.catchAll((error) => Effect.sync(() => failEnvelope(false, toError(error).message))),
  );
}

export function cancelReminderCommand(options: CancelOptions) {
  return Effect.gen(function* () {
    const reminderService = yield* ReminderServiceTag;
    yield* cancelCommand(
      options,
      "reminder",
      (agent) =>
        reminderService
          .list(agent.id)
          .pipe(Effect.map((reminders) => reminders.some((entry) => entry.id === options.id))),
      (agent) => reminderService.cancel(agent.id, options.id),
    );
  });
}

export function cancelTriggerCommand(options: CancelOptions) {
  return Effect.gen(function* () {
    const wakeTriggerService = yield* WakeTriggerServiceTag;
    yield* cancelCommand(
      options,
      "wake trigger",
      (agent) =>
        wakeTriggerService
          .list(agent.id)
          .pipe(Effect.map((triggers) => triggers.some((entry) => entry.id === options.id))),
      (agent) => wakeTriggerService.cancel(agent.id, options.id),
    );
  });
}

export function cancelJobBatchCommand(options: CancelOptions) {
  return Effect.gen(function* () {
    const jobQueueService = yield* JobQueueServiceTag;
    yield* cancelCommand(
      options,
      "job batch",
      (agent) =>
        jobQueueService
          .listActiveBatches(agent.id)
          .pipe(Effect.map((batches) => batches.some((entry) => entry.id === options.id))),
      (agent) => jobQueueService.cancelBatch(agent.id, options.id),
    );
  });
}
