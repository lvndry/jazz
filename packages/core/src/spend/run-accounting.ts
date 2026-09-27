/**
 * @fileoverview What `AgentRunner.run` does about money and about you, around every top-level
 * run: check the spend ceilings before it starts, record what it cost when it ends, and tell
 * the notify channel when it parks on a person or fails with nobody watching.
 *
 * Sub-agent and other internal runs are skipped: their cost is folded into the parent run's
 * total, which is recorded once. So is a run whose parent process records it from the run's
 * envelope (`JAZZ_SPEND_LEDGER=parent`, set by the chat bridges).
 */

import { Cause, Effect, Exit, Option } from "effect";
import { isRunParkRequested } from "@/core/agent/run/park-signal";
import type { PendingInput } from "@/core/agent/run/run-state";
import type { NotifyEvent } from "@/core/notify/events";
import { enqueueNotification } from "@/core/notify/outbox";
import type { AppConfig } from "@/core/types/config";
import { GenerationInterruptedError } from "@/core/types/errors";
import { toError } from "@/core/utils/errors";
import {
  type CeilingCheck,
  ceilingWindowKey,
  checkSpendCeilings,
  describeCeilingCheck,
  isSpendRecordedByParent,
  SpendCeilingReachedError,
} from "./ceilings";
import { localDayKey, localMonthKey, recordSpend } from "./ledger";
import { isUnattendedSource, type RunOrigin } from "./sources";

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
  readonly origin: RunOrigin;
  readonly internal: boolean;
  readonly appConfig: AppConfig;
  /** Whether the run's model is a free local one, so an unpriced run still costs nothing. */
  readonly freeLocalModel: boolean;
  /** The Jazz home whose ledger and outbox are used; defaults to this process's. */
  readonly home?: string;
}

function deliverTo(input: RunAccountingInput): { readonly channels?: readonly string[] } {
  return input.origin.deliverTo === undefined ? {} : { channels: input.origin.deliverTo };
}

function shouldAccount(input: RunAccountingInput): boolean {
  return !input.internal && !isSpendRecordedByParent();
}

/** Tell the notify channel once per ceiling and window that a run was refused. */
function notifyCeiling(
  input: RunAccountingInput,
  check: Exclude<CeilingCheck, { kind: "clear" }>,
): Effect.Effect<void> {
  const now = Date.now();
  const event: NotifyEvent = {
    kind: "spend-ceiling",
    source: input.origin.source,
    agentId: input.agentId,
    ...(input.origin.name !== undefined ? { name: input.origin.name } : {}),
    message: describeCeilingCheck(check),
  };
  return enqueueNotification(input.appConfig.notifications?.channels, event, {
    dedupeKey: ceilingWindowKey(check, { day: localDayKey(now), monthKey: localMonthKey(now) }),
    now,
    ...deliverTo(input),
    ...(input.home !== undefined ? { home: input.home } : {}),
  }).pipe(
    Effect.asVoid,
    Effect.catchAll((error) => reportAccountingError("queue a spend-ceiling notification", error)),
  );
}

function reportAccountingError(what: string, error: unknown): Effect.Effect<void> {
  return Effect.sync(() => {
    process.stderr.write(`[jazz] Could not ${what}: ${toError(error).message}\n`);
  });
}

/**
 * Check the spend ceilings before a run starts. An unattended run that a ceiling blocks fails
 * with {@link SpendCeilingReachedError} and the notify channel is told; an attended one is
 * returned the check so its surface can warn, and proceeds.
 */
export function guardRunStart(input: RunAccountingInput): Effect.Effect<CeilingCheck, Error> {
  return Effect.gen(function* () {
    if (!shouldAccount(input)) {
      return { kind: "clear" } as const;
    }
    const check = yield* checkSpendCeilings(
      input.appConfig.spend,
      { agentId: input.agentId, source: input.origin.source },
      Date.now(),
      input.home,
    ).pipe(
      Effect.catchAll((error) =>
        reportAccountingError("read the spend ledger", error).pipe(
          Effect.as<CeilingCheck>({ kind: "clear" }),
        ),
      ),
    );
    if (check.kind === "clear" || !isUnattendedSource(input.origin.source)) {
      return check;
    }
    yield* notifyCeiling(input, check);
    return yield* Effect.fail(new SpendCeilingReachedError(check));
  });
}

function pendingText(pending: PendingInput): string {
  switch (pending.kind) {
    case "tool-approval":
      return `${pending.request.toolName}: ${pending.request.message}`;
    case "question":
      return pending.request.question;
    case "file-picker":
      return pending.request.message;
  }
}

/** The notification a run's end calls for, if any. */
export function runStopNotification(
  input: Pick<RunAccountingInput, "agentId" | "origin">,
  exit: Exit.Exit<unknown, unknown>,
): { readonly event: NotifyEvent; readonly dedupeKey?: string } | undefined {
  if (Exit.isSuccess(exit)) {
    return undefined;
  }
  const failure = Cause.failureOption(exit.cause);
  const error = Option.isSome(failure) ? failure.value : undefined;
  if (isRunParkRequested(error)) {
    if (error.runId === undefined || error.expiresAt === undefined) {
      return undefined;
    }
    return {
      event: {
        kind: "approval-needed",
        runId: error.runId,
        agentId: input.agentId,
        source: input.origin.source,
        ...(input.origin.name !== undefined ? { name: input.origin.name } : {}),
        pending: error.pending.kind,
        request: pendingText(error.pending),
        expiresAt: error.expiresAt,
      },
    };
  }
  if (
    !isUnattendedSource(input.origin.source) ||
    error instanceof SpendCeilingReachedError ||
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
        runId,
      },
      input.home,
    ).pipe(Effect.catchAll((error) => reportAccountingError("record a run's spend", error)));
    const notification = runStopNotification(input, exit);
    if (notification !== undefined) {
      yield* enqueueNotification(input.appConfig.notifications?.channels, notification.event, {
        ...(notification.dedupeKey !== undefined ? { dedupeKey: notification.dedupeKey } : {}),
        ...deliverTo(input),
        ...(input.home !== undefined ? { home: input.home } : {}),
      }).pipe(
        Effect.asVoid,
        Effect.catchAll((error) => reportAccountingError("queue a notification", error)),
      );
    }
  });
}

/**
 * Between cycles of long-running work (goals, loops): whether a spend ceiling now blocks the
 * next run. The notify channel is told once per ceiling and window. The caller leaves the work
 * waiting rather than failing it, so it continues by itself once the window turns over or the
 * ceiling is raised.
 */
export function nextCycleBlockedBySpend(
  input: Omit<RunAccountingInput, "internal" | "freeLocalModel">,
): Effect.Effect<SpendCeilingReachedError | undefined> {
  return guardRunStart({ ...input, internal: false, freeLocalModel: false }).pipe(
    Effect.as(undefined),
    Effect.catchAll((error) =>
      Effect.succeed(error instanceof SpendCeilingReachedError ? error : undefined),
    ),
  );
}
