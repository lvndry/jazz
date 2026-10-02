/**
 * Remembers which models the user picked, newest first, so every model picker
 * (agent creation, agent editing, session `/model`) can surface the most
 * recently used model at the top instead of a raw catalog order.
 *
 * The history lives in Jazz state under `wizard.modelUsage`: a map of
 * `provider/model` (the `provider/model` form the pickers already use) to the
 * epoch millisecond it was last picked. Reading tolerates a missing or shaped
 * differently history, and recording never throws — a picker must not fail
 * because the state file could not be written.
 */
import { JazzStateServiceTag, type JazzStateService } from "@jazz/core/interfaces/jazz-state";
import { isRecord } from "@jazz/core/utils/is-record";
import { Effect } from "effect";

const MODEL_USAGE_KEY = "wizard.modelUsage";
const MAX_REMEMBERED_MODELS = 100;

/** The `provider/model` form a picker's recency lookup expects. */
export function modelUsageKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}

/** The last-picked millisecond per `provider/model`, empty when none is remembered. */
export function modelUsage(): Effect.Effect<Map<string, number>, never, JazzStateService> {
  return Effect.gen(function* () {
    const jazzState = yield* JazzStateServiceTag;
    const raw = yield* jazzState.get<unknown>(MODEL_USAGE_KEY);
    const map = new Map<string, number>();
    if (isRecord(raw)) {
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value === "number" && Number.isFinite(value)) {
          map.set(key, value);
        }
      }
    }
    return map;
  });
}

/**
 * Remember that the user picked a model now. Keeps only the newest
 * `MAX_REMEMBERED_MODELS` entries so the state file cannot grow without bound.
 */
export function recordModelUsage(
  provider: string,
  model: string,
): Effect.Effect<void, never, JazzStateService> {
  return Effect.gen(function* () {
    const jazzState = yield* JazzStateServiceTag;
    const current = yield* modelUsage();
    current.set(modelUsageKey(provider, model), Date.now());
    const pruned = [...current.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, MAX_REMEMBERED_MODELS)
      .map(([key, at]) => [key, at] as const)
      .reduce<Record<string, number>>((object, [key, at]) => {
        object[key] = at;
        return object;
      }, {});
    yield* jazzState.set(MODEL_USAGE_KEY, pruned).pipe(Effect.catchAll(() => Effect.void));
  });
}
