/**
 * @fileoverview Directory occupancy: which jazz runs are live where, and what they are doing.
 *
 * Every jazz process that runs a turn heartbeats one entry into a shared local file
 * (`$JAZZ_HOME/occupancy.json`). Presence is heartbeat freshness — an agent is "here" while it
 * is actually executing, and drops out within a minute of finishing or crashing. No run is
 * ever "here" in the memory sense: a finished run simply stops heartbeating.
 *
 * The write signal is the load-bearing part. Knowing that an agent is in a directory only
 * warns; knowing it is *writing* there tells you whether checking out a branch or running a
 * worktree would collide. The executor already resolves each tool call to a risk level for
 * approval gating, so "mutating" means exactly what the approval policy means: anything whose
 * resolved level is not `read-only`.
 */
/** The states a heartbeat may report. Terminal states appear only on the final write. */
export type OccupancyRunState = "working" | "input-required" | "completed" | "failed" | "canceled";

/**
 * One heartbeat entry, one per live (or just-finished) run, keyed by `runId` in the file.
 *
 * `lastMutatingPath` is only set when the mutating tool carried a path argument of its own. A
 * shell command's write target is generally unknown — the entry says so rather than guess.
 */
export interface OccupancyEntry {
  readonly runId: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly conversationId: string;
  readonly workingDirectory: string;
  /** The prompt that started the run, kept short. A truncated title, not a transcript. */
  readonly promptExcerpt?: string;
  readonly state: OccupancyRunState;
  readonly pid: number;
  readonly host: string;
  /** When this entry was last written. Freshness, not age, is what makes it present. */
  readonly updatedAt: string;
  /** Last tool call whose resolved risk was not `read-only`. */
  readonly lastMutatingAt?: string;
  readonly lastMutatingTool?: string;
  readonly lastMutatingPath?: string;
  /** Last read-only tool call, for the "present, reads only" band. */
  readonly lastReadAt?: string;
}

/**
 * How `who_is_here` bands an occupant.
 *
 * `writing` is the collision-relevant band: a mutating call within the recent window.
 * `wrote-idle` is history within the same run — it touched the tree, then went quiet.
 * `reading` is presence without a mutating call. The bands are computed at read time from
 * the entry's timestamps, so they need no extra writes.
 */
export type OccupancyBand = "writing" | "wrote-idle" | "reading";

/** Whether the entry's process is still alive, from the point of view of this machine. */
export type OccupancyOwnerStatus = "alive" | "gone" | "unverifiable";

/** A present occupant with its computed band and owner status, ready to render. */
export interface OccupancyOccupant {
  readonly entry: OccupancyEntry;
  readonly band: OccupancyBand;
  readonly owner: OccupancyOwnerStatus;
}
