import { fireWakeTrigger } from "@jazz/adapters/daemon/trigger-runner";
import { LoggerServiceTag } from "@jazz/core/interfaces/logger";
import { WakeTriggerServiceTag } from "@jazz/core/interfaces/wake-trigger-service";
import { Effect } from "effect";

/**
 * Internal command invoked by the host scheduler (launchd/`at`), not meant for interactive use:
 * fire one specific wake trigger, one-shot.
 *
 * Cancels the trigger's JSON record before firing it, so the in-process ticker can never pick
 * up the same trigger and fire it a second time if both race. A trigger that is no longer
 * found (already fired by the ticker, or cancelled by the user) is an expected race, not an
 * error — this exits cleanly rather than failing the scheduler job.
 */
export function fireWakeTriggerCommand(options: { agent: string; id: string }) {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const wakeTriggerService = yield* WakeTriggerServiceTag;

    const triggers = yield* wakeTriggerService.list(options.agent);
    const trigger = triggers.find((candidate) => candidate.id === options.id);

    if (trigger === undefined) {
      yield* logger.info("Wake trigger not found — likely already fired or cancelled", {
        agentId: options.agent,
        triggerId: options.id,
      });
      return;
    }

    yield* wakeTriggerService.cancel(options.agent, options.id);
    yield* fireWakeTrigger(options.agent, trigger);
  });
}
