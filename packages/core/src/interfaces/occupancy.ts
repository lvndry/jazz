import { Context, Effect } from "effect";
import type { OccupancyEntry } from "@/core/types/occupancy";

/**
 * @fileoverview The directory-occupancy port.
 *
 * Run recording (`RunStore`) answers "what did this process's runs do". Occupancy answers the
 * cross-process question that run history cannot: "is another jazz on this machine working in
 * this directory *right now*". The only implementation is the shared local file, but the port
 * lives here because the run recorder (core) is what writes the heartbeats.
 *
 * Absent means "nobody can be told", not an error: a layer without this service simply does not
 * heartbeat, the same way a layer without `RunStore` does not record runs. Terminal sessions
 * get it too — that is the whole point, since a second terminal is exactly who needs to know.
 */
export interface OccupancyService {
  /**
   * Upsert this run's entry. Called by the heartbeat every few seconds and once more on the
   * run's final transition, so a finished run's terminal state is visible for a moment rather
   * than vanishing mid-read.
   */
  readonly record: (entry: OccupancyEntry) => Effect.Effect<void, never>;
  /**
   * Every entry known to this machine. The implementation prunes on read (stale timestamps,
   * dead pids), so callers may filter by freshness and still get live results.
   */
  readonly list: () => Effect.Effect<readonly OccupancyEntry[], never>;
}

export const OccupancyServiceTag = Context.GenericTag<OccupancyService>("OccupancyService");
