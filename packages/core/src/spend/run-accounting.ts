/**
 * @fileoverview What `AgentRunner.run` does about money and about you, around every top-level
 * run: check the `daemon` spend caps before it starts, record what it cost in the ledger when it
 * ends, and tell the `notify` targets when it parks on a person or fails with nobody watching.
 *
 * A run is unattended when nobody could be asked while it runs (no presentation that can
 * prompt), and a `jazz run` always is (see {@link isUnattendedRun}): only those count toward the
 * caps, only those are refused at one, and only their failures are notified. A run answering a
 * parked one (`resume`) is never refused: that is the person acting on what already waits.
 *
 * An unattended run that passes the check holds an in-flight reservation in the ledger until it
 * ends ({@link releaseRunReservation}), so runs starting at once see each other's spend.
 *
 * Sub-agent and other internal runs are skipped: their cost is folded into the parent run's
 * total, which is recorded once. So is a run whose parent process records it from the run's
 * envelope (`JAZZ_SPEND_LEDGER=parent`, set by the chat bridges).
 */

import { Cause, Effect, Exit, Option } from "effect";
import { isRunParkRequested } from "@/core/agent/run/park-signal";
import { capLifted, parkedRunWaitingItem } from "@/core/daemon/attention";
import { daemonStatePath, readDaemonStateFile } from "@/core/daemon/daemon-state";
import type { NotifyEvent } from "@/core/notify/events";
import { enqueueNotification, notifyTargets } from "@/core/notify/outbox";
import type { AppConfig } from "@/core/types/config";
import { GenerationInterruptedError } from "@/core/types/errors";
import { toError } from "@/core/utils/errors";
import { getJazzHomeDirectory } from "@/core/utils/paths";
import {
  type BlockingCap,
  type CapCheck,
  capWindowKey,
  checkAndReserveSpendCaps,
  checkSpendCaps,
  describeCapCheck,
  isSpendRecordedByParent,
  listCapAgents,
  SpendCapReachedError,
} from "./caps";
import { localDayKey, localMonthKey, recordSpend, releaseInFlightSpend } from "./ledger";
import type { RunOrigin, SpendSource } from "./sources";

/**
 * Whether nobody can be asked while a run works. A `jazz run` counts as unattended even with
 * `--events`, where a program answers its prompts: a parent that answers for a person takes over
 * its accounting with `JAZZ_SPEND_LEDGER=parent`, and the run is then not accounted here at all.
 */
export function isUnattendedRun(source: SpendSource, canPromptForApproval: boolean): boolean {
  return source === "run" || !canPromptForApproval;
}

/**
 * A run's spend on exit: the dollars (undefined until something was priced), whether any of
 * it went unpriced, and its own prompt plus completion tokens.
 */
export interface RunExitSpend {
  readonly costUSD: number | undefined;
  readonly costIncomplete: boolean;
  readonly totalTokens: number;
}

export interface RunAccountingInput {
  readonly agentId: string;
  /** Matched against `daemon.agents` keys alongside the id. */
  readonly agentName?: string;
  readonly origin: RunOrigin;
  readonly internal: boolean;
  /** Nobody can be asked while this run works. */
  readonly unattended: boolean;
  readonly appConfig: AppConfig;
  /** Whether the run's model is a free local one, so an unpriced run still costs nothing. */
  readonly freeLocalModel: boolean;
  /** The Jazz home whose ledger, outbox and daemon state are used; defaults to this process's. */
  readonly home?: string;
  /**
   * The in-flight reservation an unattended run that passes the check holds until
   * {@link releaseRunReservation}. Without one the check only reads.
   */
  readonly reservationId?: string;
}

function enqueueOptions(input: RunAccountingInput) {
  return {
    ...(input.origin.deliverTo !== undefined ? { targets: input.origin.deliverTo } : {}),
    ...(input.home !== undefined ? { home: input.home } : {}),
  };
}

function shouldAccount(input: RunAccountingInput): boolean {
  return !input.internal && !isSpendRecordedByParent();
}

function reportAccountingError(what: string, error: unknown): Effect.Effect<void> {
  return Effect.sync(() => {
    process.stderr.write(`[jazz] Could not ${what}: ${toError(error).message}\n`);
  });
}

/** Tell the notify targets once per cap and window that a run was refused. */
function notifyCap(input: RunAccountingInput, check: BlockingCap): Effect.Effect<void> {
  const now = Date.now();
  const event: NotifyEvent = {
    kind: "spend-cap",
    source: input.origin.source,
    agentId: input.agentId,
    ...(input.origin.name !== undefined ? { name: input.origin.name } : {}),
    message: describeCapCheck(check),
  };
  return enqueueNotification(notifyTargets(input.appConfig), event, {
    dedupeKey: capWindowKey(check, { day: localDayKey(now), monthKey: localMonthKey(now) }),
    now,
    ...enqueueOptions(input),
  }).pipe(
    Effect.asVoid,
    Effect.catchAll((error) => reportAccountingError("queue a spend-cap notification", error)),
  );
}

/** Whether `jazz daemon resume` lifted the machine-wide daily cap for today. */
function machineCapLifted(home: string | undefined): Effect.Effect<boolean> {
  return Effect.promise(() =>
    readDaemonStateFile(daemonStatePath(home ?? getJazzHomeDirectory())),
  ).pipe(Effect.map((state) => capLifted(state, new Date())));
}

/**
 * The run's agent name, for matching `daemon.agents` keys: as given, or looked up by id when an
 * agent cap is configured and the caller did not pass it.
 */
function resolveAgentName(input: RunAccountingInput): Effect.Effect<string | undefined> {
  if (input.agentName !== undefined) {
    return Effect.succeed(input.agentName);
  }
  if (Object.keys(input.appConfig.daemon?.agents ?? {}).length === 0) {
    return Effect.succeed(undefined);
  }
  return Effect.map(
    listCapAgents(),
    (agents) => agents.find((agent) => agent.id === input.agentId)?.name,
  );
}

/**
 * Check the spend caps before a run starts. An unattended run a cap covers fails with
 * {@link SpendCapReachedError} and the notify targets are told; an attended one is returned the
 * check so its surface can warn, and proceeds.
 */
export function guardRunStart(input: RunAccountingInput): Effect.Effect<CapCheck, Error> {
  return Effect.gen(function* () {
    if (!shouldAccount(input) || input.origin.source === "resume") {
      return { kind: "clear" } as const;
    }
    const agentName = yield* resolveAgentName(input);
    const subject = {
      agentId: input.agentId,
      ...(agentName !== undefined ? { agentName } : {}),
      source: input.origin.source,
    };
    const options = {
      machineCapLifted: yield* machineCapLifted(input.home),
      ...(input.home !== undefined ? { home: input.home } : {}),
    };
    const check = yield* (
      input.unattended && input.reservationId !== undefined
        ? checkAndReserveSpendCaps(input.appConfig.daemon, subject, input.reservationId, options)
        : checkSpendCaps(input.appConfig.daemon, subject, options)
    ).pipe(
      Effect.catchAll((error) =>
        reportAccountingError("read the spend ledger", error).pipe(
          Effect.as<CapCheck>({ kind: "clear" }),
        ),
      ),
    );
    if (check.kind === "clear" || !input.unattended) {
      return check;
    }
    yield* notifyCap(input, check);
    return yield* Effect.fail(new SpendCapReachedError(check));
  });
}

/** Drop the in-flight reservation {@link guardRunStart} took for this run, if any. */
export function releaseRunReservation(input: RunAccountingInput): Effect.Effect<void> {
  if (input.reservationId === undefined) {
    return Effect.void;
  }
  return releaseInFlightSpend(input.reservationId, input.home).pipe(
    Effect.catchAll((error) => reportAccountingError("release a spend reservation", error)),
  );
}

/** How a waiting item names what parked: "Goal ship-docs", "Loop deploy-watch", "A run". */
function waiterName(origin: RunOrigin): string {
  if (origin.name !== undefined && (origin.source === "goal" || origin.source === "loop")) {
    return `${origin.source === "goal" ? "Goal" : "Loop"} ${origin.name}`;
  }
  if (origin.name !== undefined && origin.source === "workflow") {
    return `Workflow ${origin.name}`;
  }
  return "A run";
}

/** The notification a run's end calls for, if any, with the key that sends it once. */
export function runStopNotification(
  input: Pick<RunAccountingInput, "agentId" | "origin" | "unattended">,
  exit: Exit.Exit<unknown, unknown>,
): { readonly event: NotifyEvent; readonly dedupeKey: string } | undefined {
  if (Exit.isSuccess(exit)) {
    return undefined;
  }
  const failure = Cause.failureOption(exit.cause);
  const error = Option.isSome(failure) ? failure.value : undefined;
  if (isRunParkRequested(error)) {
    if (error.runId === undefined || error.expiresAt === undefined) {
      return undefined;
    }
    const item = parkedRunWaitingItem({
      runId: error.runId,
      agentId: input.agentId,
      pending: error.pending,
      since: new Date().toISOString(),
      who: waiterName(input.origin),
    });
    return { event: { kind: "waiting", item }, dedupeKey: item.key };
  }
  if (
    !input.unattended ||
    error instanceof SpendCapReachedError ||
    error instanceof GenerationInterruptedError ||
    Cause.isInterruptedOnly(exit.cause)
  ) {
    return undefined;
  }
  const message = error === undefined ? Cause.pretty(exit.cause) : toError(error).message;
  return {
    event: {
      kind: "unattended-failed",
      source: input.origin.source,
      ...(input.origin.name !== undefined ? { name: input.origin.name } : {}),
      agentId: input.agentId,
      error: message,
    },
    dedupeKey: `failed:${input.origin.source}:${input.origin.name ?? input.agentId}:${localDayKey(Date.now())}:${message.slice(0, 120)}`,
  };
}

/**
 * Record a finished run's cost in the ledger and queue the notification its end calls for.
 * Never fails: an accounting error is reported on stderr, since failing a run that already
 * spent the money would only lose its answer too.
 */
export function settleRunAccounting(
  input: RunAccountingInput,
  spend: RunExitSpend,
  exit: Exit.Exit<unknown, unknown>,
  runId: string,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (!shouldAccount(input)) {
      return;
    }
    const priced = spend.costUSD !== undefined || spend.totalTokens === 0 || input.freeLocalModel;
    yield* recordSpend(
      {
        agentId: input.agentId,
        source: input.origin.source,
        costUSD: spend.costUSD ?? 0,
        costKnown: priced && !spend.costIncomplete,
        tokens: spend.totalTokens,
        unattended: input.unattended,
        runId,
      },
      input.home,
    ).pipe(Effect.catchAll((error) => reportAccountingError("record a run's spend", error)));
    const notification = runStopNotification(input, exit);
    if (notification !== undefined) {
      yield* enqueueNotification(notifyTargets(input.appConfig), notification.event, {
        dedupeKey: notification.dedupeKey,
        ...enqueueOptions(input),
      }).pipe(
        Effect.asVoid,
        Effect.catchAll((error) => reportAccountingError("queue a notification", error)),
      );
    }
  });
}

/**
 * Between cycles of long-running work (goals, loops): whether a spend cap now blocks the next
 * run. The notify targets are told once per cap and window. The caller leaves the work waiting
 * rather than failing it, so it continues by itself once the window turns over or the cap is
 * raised.
 */
export function nextCycleBlockedBySpend(
  input: Omit<RunAccountingInput, "internal" | "freeLocalModel" | "unattended" | "reservationId">,
): Effect.Effect<SpendCapReachedError | undefined> {
  return guardRunStart({ ...input, internal: false, freeLocalModel: false, unattended: true }).pipe(
    Effect.as(undefined),
    Effect.catchAll((error) =>
      Effect.succeed(error instanceof SpendCapReachedError ? error : undefined),
    ),
  );
}
