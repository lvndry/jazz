/**
 * @fileoverview What needs the person who runs the daemon, whether the daemon may start work, and
 * telling them.
 *
 * `listWaiting` is the one list of everything waiting on them: a parked run's approval, question,
 * or file, a goal stopped for review or at its cycle cap, a loop that stopped. `GET /waiting`,
 * `jazz daemon status`, the notifier, and `GET /events` all read it. `daemonGate` is asked before
 * the daemon starts any work of its own; it pauses the daemon once today's unattended spend
 * reaches a daily cap (read from the spend ledger). `announceWaiting`, run every tick, tells the
 * person about each new item and about a pause, by queueing them on the `notify` targets'
 * outbox (`notify/outbox.ts`), which delivers and retries them.
 */

import { listOwnedGoals } from "@jazz/adapters/goals/goal-actions";
import { listOwnedLoops } from "@jazz/adapters/loops/loop-actions";
import { drainNotifyOutbox } from "@jazz/adapters/notification/outbox-drain";
import { readDaemonState, updateDaemonState } from "@jazz/adapters/storage/daemon-state-store";
import type { GoalRecord } from "@jazz/core/agent/goal/goal-record";
import type { LoopRecord } from "@jazz/core/agent/loop/loop-record";
import type { RunRecord } from "@jazz/core/agent/run/run-record";
import {
  capLifted,
  keepNotified,
  newlyWaiting,
  parkedRunWaitingItem,
  pauseInForce,
  startOfNextLocalDay,
  type DaemonPause,
  type WaitingItem,
} from "@jazz/core/daemon/attention";
import { AgentConfigServiceTag } from "@jazz/core/interfaces/agent-config";
import { type LoggerService, LoggerServiceTag } from "@jazz/core/interfaces/logger";
import { RunStoreTag } from "@jazz/core/interfaces/run-store";
import type { NotifyEvent } from "@jazz/core/notify/events";
import {
  enqueueNotification,
  NotificationQueueError,
  notifyTargets,
} from "@jazz/core/notify/outbox";
import {
  blockingMachineDailyCap,
  capStatuses,
  hasMachineDailyCap,
  listCapAgents,
  unattendedSpend,
} from "@jazz/core/spend/caps";
import { readSpend } from "@jazz/core/spend/ledger";
import type { AppConfig } from "@jazz/core/types/config";
import { Effect } from "effect";

/**
 * The configuration as the file says now: a long-lived daemon rereads it when it changed, so a
 * cap or notification channel set while it runs applies on the next tick.
 */
function liveConfig() {
  return Effect.flatMap(AgentConfigServiceTag, (service) =>
    Effect.zipRight(service.reloadIfChanged(), service.appConfig),
  );
}

function goalLabel(goal: Pick<GoalRecord, "goalId" | "name">): string {
  return `Goal ${goal.name ?? goal.goalId.slice(0, 8)}`;
}

function runItem(
  run: RunRecord,
  owners: { readonly goals: readonly GoalRecord[]; readonly loops: readonly LoopRecord[] },
): WaitingItem | undefined {
  if (run.state.kind !== "input-required") {
    return undefined;
  }
  const { pending } = run.state;
  const goal = owners.goals.find((candidate) => candidate.cycle?.runId === run.runId);
  const loop = owners.loops.find((candidate) => candidate.run?.runId === run.runId);
  const who =
    goal !== undefined ? goalLabel(goal) : loop !== undefined ? `Loop ${loop.name}` : "A run";
  return parkedRunWaitingItem({
    runId: run.runId,
    agentId: run.agentId,
    pending,
    since: run.updatedAt,
    who,
    conversationId: goal?.sourceConversationId ?? loop?.sourceConversationId ?? run.conversationId,
    ...(goal !== undefined ? { goalId: goal.goalId } : {}),
    ...(loop !== undefined ? { loopId: loop.loopId } : {}),
  });
}

function goalItem(goal: GoalRecord): WaitingItem | undefined {
  const common = {
    since: goal.updatedAt,
    goalId: goal.goalId,
    agentId: goal.agentId,
    ...(goal.sourceConversationId !== undefined
      ? { conversationId: goal.sourceConversationId }
      : {}),
  };
  if (goal.state.kind === "review-required") {
    return {
      ...common,
      key: `goal:${goal.goalId}:${goal.updatedAt}`,
      kind: "goal-review",
      title:
        goal.state.question !== undefined
          ? `${goalLabel(goal)} has a question`
          : `${goalLabel(goal)} stopped`,
      detail: goal.state.question ?? goal.state.reason,
    };
  }
  if (goal.state.kind === "budget-limited") {
    return {
      ...common,
      key: `goal:${goal.goalId}:${goal.updatedAt}`,
      kind: "goal-limit",
      title: `${goalLabel(goal)} used its cycles`,
      detail: `It ran the ${String(goal.budget.maxCycles ?? goal.usage.cycles)} cycles it was given; resume it to give it as many again.`,
    };
  }
  return undefined;
}

function loopItem(loop: LoopRecord): WaitingItem | undefined {
  const common = {
    since: loop.updatedAt,
    loopId: loop.loopId,
    agentId: loop.agentId,
    ...(loop.sourceConversationId !== undefined
      ? { conversationId: loop.sourceConversationId }
      : {}),
  };
  if (loop.state.kind === "failed") {
    return {
      ...common,
      key: `loop:${loop.loopId}:${loop.updatedAt}`,
      kind: "loop-stopped",
      title: `Loop ${loop.name} stopped`,
      detail: loop.state.reason,
    };
  }
  if (loop.state.kind === "budget-limited") {
    return {
      ...common,
      key: `loop:${loop.loopId}:${loop.updatedAt}`,
      kind: "loop-stopped",
      title: `Loop ${loop.name} ran out of ${loop.state.limit} budget`,
      detail: "Resume it to give it another default budget.",
    };
  }
  return undefined;
}

/**
 * Everything waiting on the person, oldest first: parked runs that have not expired, goals
 * stopped for them, and loops that stopped. A goal's or loop's parked run is listed once, as
 * the run, named after its goal or loop.
 */
export function listWaiting(now: Date = new Date()) {
  return Effect.gen(function* () {
    const runs = yield* RunStoreTag;
    const goals = yield* listOwnedGoals();
    const loops = yield* listOwnedLoops();
    const parked = (yield* runs.list()).filter(
      (run) =>
        run.state.kind === "input-required" && Date.parse(run.state.expiresAt) > now.getTime(),
    );
    const items = [
      ...parked.map((run) => runItem(run, { goals, loops })),
      ...goals.map(goalItem),
      ...loops.map(loopItem),
    ].filter((item): item is WaitingItem => item !== undefined);
    return items.sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
  });
}

/** The spend ledger now, and what unattended runs spent since local midnight. */
function ledgerSpend(now: Date) {
  return readSpend(now.getTime()).pipe(
    Effect.map((spend) => ({ spend, today: unattendedSpend(spend.today) })),
  );
}

/** What unattended runs have spent since local midnight, from the spend ledger. */
export function spendToday(now: Date = new Date()) {
  return Effect.map(ledgerSpend(now), ({ today }) => today);
}

export type DaemonGate =
  { readonly kind: "open" } | { readonly kind: "paused"; readonly pause: DaemonPause };

/** Why background work is not starting, for a notification, a refusal, or a status line. */
export function describePause(pause: DaemonPause): string {
  return pause.kind === "user"
    ? "Paused by you. `jazz daemon resume` starts it again."
    : `Paused at its daily ${pause.limit === "cost" ? "dollar" : "token"} cap until ${new Date(pause.until).toLocaleString()}. \`jazz daemon resume\` starts it now.`;
}

/**
 * Whether the daemon may start work of its own now. Past a daily cap it pauses itself until the
 * day ends, so the cap is checked once per start instead of every run racing to spend it.
 * Answering what already waits is never gated: that is the person acting, not the daemon.
 */
export function daemonGate(now: Date = new Date()) {
  return Effect.gen(function* () {
    const state = yield* readDaemonState();
    const inForce = pauseInForce(state, now);
    if (inForce !== undefined) {
      const gate: DaemonGate = { kind: "paused", pause: inForce };
      return gate;
    }
    if (capLifted(state, now)) {
      const gate: DaemonGate = { kind: "open" };
      return gate;
    }
    const config = yield* liveConfig();
    if (!hasMachineDailyCap(config.daemon)) {
      const gate: DaemonGate = { kind: "open" };
      return gate;
    }
    const { spend } = yield* ledgerSpend(now);
    const limit = blockingMachineDailyCap(config.daemon, spend);
    if (limit === undefined) {
      const gate: DaemonGate = { kind: "open" };
      return gate;
    }
    const pause: DaemonPause = {
      kind: "daily-cap",
      at: now.toISOString(),
      limit,
      until: startOfNextLocalDay(now).toISOString(),
    };
    yield* updateDaemonState((current) => ({ ...current, paused: pause })).pipe(
      Effect.catchAll(() => Effect.void),
    );
    const gate: DaemonGate = { kind: "paused", pause };
    return gate;
  });
}

/** Stop the daemon starting work of its own until `resumeDaemon`. What is already running finishes. */
export function pauseDaemon(now: Date = new Date()) {
  return updateDaemonState((state) => ({
    ...state,
    paused: { kind: "user", at: now.toISOString() },
  }));
}

/**
 * Let the daemon start work again, and lift the machine daily caps until the next local midnight
 * when one blocks today (read from the ledger), whether or not a running daemon paused on it:
 * otherwise the next start would find today's spend still over it and stop again.
 */
export function resumeDaemon(now: Date = new Date()) {
  return Effect.gen(function* () {
    const config = yield* liveConfig();
    const capBlocksToday = hasMachineDailyCap(config.daemon)
      ? yield* readSpend(now.getTime()).pipe(
          Effect.map((spend) => blockingMachineDailyCap(config.daemon, spend) !== undefined),
          Effect.catchAll(() => Effect.succeed(false)),
        )
      : false;
    return yield* updateDaemonState(({ paused, ...state }) => {
      const pausedAtCap =
        paused?.kind === "daily-cap" && pauseInForce({ ...state, paused }, now) !== undefined;
      return pausedAtCap || capBlocksToday
        ? { ...state, capLiftedUntil: startOfNextLocalDay(now).toISOString() }
        : state;
    });
  });
}

interface AnnouncementOutcome {
  /** The event is on every target it routes to, or had been already: announce it no more. */
  readonly settled: boolean;
  /** This call put it on at least one target's queue. */
  readonly queued: boolean;
}

/**
 * Queue one event on the `notify` targets, once per key. A target that could not take it is
 * logged and leaves the announcement unsettled, so the next tick tries that target again.
 */
function queueAnnouncement(
  config: AppConfig,
  event: NotifyEvent,
  dedupeKey: string,
): Effect.Effect<AnnouncementOutcome, never, LoggerService> {
  return enqueueNotification(notifyTargets(config), event, { dedupeKey }).pipe(
    Effect.map((result) => ({ settled: true, queued: result.queued.length > 0 })),
    Effect.catchAll((error) =>
      Effect.flatMap(LoggerServiceTag, (logger) =>
        logger.warn("Could not queue a daemon notification", { error: error.message }),
      ).pipe(
        Effect.as({
          settled: false,
          queued: error instanceof NotificationQueueError && error.queued.length > 0,
        }),
      ),
    ),
  );
}

/**
 * One tick of announcing: each item not announced yet, and a pause the daemon took itself since
 * the last tick. Only what reached every target is recorded as announced; the record keeps only
 * items still waiting. Returns the items announced this tick.
 */
export function announceWaiting(now: Date = new Date()) {
  return Effect.gen(function* () {
    const config = yield* liveConfig();
    const state = yield* readDaemonState();
    const items = yield* listWaiting(now);
    const fresh = newlyWaiting(items, state.notified);
    let queued = false;
    const announced: WaitingItem[] = [];
    for (const item of fresh) {
      const outcome = yield* queueAnnouncement(config, { kind: "waiting", item }, item.key);
      queued = outcome.queued || queued;
      if (outcome.settled) {
        announced.push(item);
      }
    }
    const pause = pauseInForce(state, now);
    const pauseKey = pause?.kind === "daily-cap" ? `pause:${pause.at}` : undefined;
    const announcePause = pauseKey !== undefined && state.notified[pauseKey] === undefined;
    let pauseAnnounced = false;
    if (announcePause && pause !== undefined && pauseKey !== undefined) {
      const outcome = yield* queueAnnouncement(
        config,
        { kind: "paused", pause, reason: describePause(pause) },
        pauseKey,
      );
      queued = outcome.queued || queued;
      pauseAnnounced = outcome.settled;
    }
    if (queued) {
      yield* drainNotifyOutbox();
    }
    if (announced.length === 0 && !pauseAnnounced) {
      return announced;
    }
    const stamp = now.toISOString();
    yield* updateDaemonState((current) => ({
      ...current,
      notified: {
        ...keepNotified(current.notified, items),
        ...Object.fromEntries(Object.entries(current.notified).filter(([key]) => key === pauseKey)),
        ...Object.fromEntries(announced.map((item) => [item.key, stamp])),
        ...(pauseAnnounced && pauseKey !== undefined ? { [pauseKey]: stamp } : {}),
      },
    })).pipe(Effect.catchAll(() => Effect.void));
    return announced;
  });
}

/** Where the daemon stands: paused or not and why, today's unattended spend against its caps, and what waits. */
export function daemonStatusSnapshot(now: Date = new Date()) {
  return Effect.gen(function* () {
    const config = yield* liveConfig();
    const state = yield* readDaemonState();
    const pause = pauseInForce(state, now);
    const ledger = yield* ledgerSpend(now);
    const lifted = capLifted(state, now);
    const capReached =
      pause === undefined && !lifted
        ? blockingMachineDailyCap(config.daemon, ledger.spend)
        : undefined;
    return {
      paused: pause ?? null,
      ...(pause !== undefined
        ? { pauseReason: describePause(pause) }
        : capReached !== undefined
          ? {
              pauseReason: `At its daily ${capReached === "cost" ? "dollar" : "token"} cap: nothing new starts until midnight or \`jazz daemon resume\`.`,
            }
          : {}),
      spendToday: ledger.today,
      caps: capStatuses(config.daemon, ledger.spend, {
        agents: yield* listCapAgents(),
        ...(lifted && state.capLiftedUntil !== undefined
          ? { machineCapLiftedUntil: state.capLiftedUntil }
          : {}),
      }),
      capLiftedToday: lifted,
      waiting: yield* listWaiting(now),
    };
  });
}
