import { makeFileRunStoreLayer } from "@jazz/adapters/storage/run-store";
import { claimWakeTrigger } from "@jazz/adapters/wake-trigger-service";
import { LoggerServiceTag } from "@jazz/core/interfaces/logger";
import { createWakeTriggerOsScheduler } from "@jazz/core/wake-triggers/wake-trigger-os-scheduler";
import { deliverWakeTrigger, wakeTriggerDirectory } from "@jazz/daemon/trigger-runner";
import { Effect } from "effect";

/**
 * Internal command invoked by the host scheduler (launchd/`at`), not meant for interactive use:
 * fire one specific wake trigger, one-shot.
 *
 * The trigger is claimed under its agent's lock before the turn starts, so the daemon's ticker
 * (which claims the same way) can never run it a second time; if the ticker got there first,
 * this does nothing. The record is removed only after the turn finished or parked; a failed
 * turn keeps it with the error, for the daemon to retry. Either way the host scheduler's
 * one-shot job is removed at the end, since it has fired.
 *
 * The turn runs with the file run store, because a run that needs an approval nobody can give
 * parks itself there; without it the park is unsaved and the trigger fails as unresumable.
 */
export function fireWakeTriggerCommand(options: { agent: string; id: string }) {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const osScheduler = yield* createWakeTriggerOsScheduler();
    const trigger = yield* claimWakeTrigger(wakeTriggerDirectory(), options.agent, options.id);

    if (trigger === undefined) {
      yield* logger.info("Wake trigger not claimed: already fired, being fired, or cancelled");
    } else {
      yield* deliverWakeTrigger(options.agent, trigger);
    }

    yield* osScheduler
      .cancelFire(options.agent, options.id, trigger?.osSchedulerJobId)
      .pipe(Effect.catchAll(() => Effect.void));
  }).pipe(Effect.provide(makeFileRunStoreLayer()));
}
