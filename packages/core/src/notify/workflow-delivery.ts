/**
 * @fileoverview Delivering a scheduled workflow's answer to the targets its `deliver:` names,
 * and reporting a workflow that could not run at all.
 *
 * A failed or parked workflow run is reported by the runner itself (see
 * `spend/run-accounting.ts`), to the same `deliver:` targets plus every target subscribed to
 * that event. What is left here is the result, and the failures that happen before any run
 * starts (a missing agent, an unreadable WORKFLOW.md).
 */

import { Effect } from "effect";
import type { AppConfig } from "@/core/types/config";
import { toError } from "@/core/utils/errors";
import { enqueueNotification, notifyTargets } from "./outbox";

function warnMissing(workflow: string, missing: readonly string[]): Effect.Effect<void> {
  if (missing.length === 0) {
    return Effect.void;
  }
  return Effect.sync(() => {
    process.stderr.write(
      `[jazz] Workflow "${workflow}" delivers to ${missing.map((name) => `"${name}"`).join(", ")}, but no such notify target is configured (notify.targets).\n`,
    );
  });
}

function warnQueueFailure(workflow: string, error: unknown): Effect.Effect<void> {
  return Effect.sync(() => {
    process.stderr.write(
      `[jazz] Could not queue the notification for workflow "${workflow}": ${toError(error).message}\n`,
    );
  });
}

/** Queue a workflow's answer on its `deliver:` targets. Returns the targets it went to. */
export function deliverWorkflowResult(input: {
  readonly config: Pick<AppConfig, "notify" | "notifications">;
  readonly workflow: string;
  readonly deliver: readonly string[] | undefined;
  readonly agentId: string;
  readonly answer: string;
}): Effect.Effect<readonly string[]> {
  if (input.deliver === undefined || input.deliver.length === 0) {
    return Effect.succeed([]);
  }
  return enqueueNotification(
    notifyTargets(input.config),
    {
      kind: "workflow-result",
      workflow: input.workflow,
      agentId: input.agentId,
      answer: input.answer,
    },
    { targets: input.deliver },
  ).pipe(
    Effect.tap((result) => warnMissing(input.workflow, result.missing)),
    Effect.map((result) => result.queued),
    Effect.catchAll((error) =>
      warnQueueFailure(input.workflow, error).pipe(Effect.as([] as readonly string[])),
    ),
  );
}

/** Report a scheduled workflow that failed before its run could start. */
export function notifyWorkflowNotRun(input: {
  readonly config: Pick<AppConfig, "notify" | "notifications">;
  readonly workflow: string;
  readonly deliver: readonly string[] | undefined;
  readonly agentId?: string;
  readonly error: string;
}): Effect.Effect<void> {
  return enqueueNotification(
    notifyTargets(input.config),
    {
      kind: "unattended-failed",
      source: "workflow",
      name: input.workflow,
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      error: input.error,
    },
    input.deliver === undefined ? {} : { targets: input.deliver },
  ).pipe(
    Effect.tap((result) => warnMissing(input.workflow, result.missing)),
    Effect.asVoid,
    Effect.catchAll((error) => warnQueueFailure(input.workflow, error)),
  );
}
