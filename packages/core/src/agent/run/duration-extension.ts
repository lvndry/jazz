/**
 * Extra wall-clock time granted to a run after it started. A sub-agent's time limit is fixed
 * when it starts; the parent that started it raises the limit through this object, and the
 * child's loop adds {@link DurationExtension.extraMs} wherever it reads the limit.
 */
export interface DurationExtension {
  /** Milliseconds granted so far, in total. */
  readonly extraMs: () => number;
  /** Grants `ms` more. */
  readonly add: (ms: number) => void;
  /**
   * Marks the run as stopped for time: it is writing its answer, and more time would no longer
   * resume its work.
   */
  readonly close: () => void;
  /** Whether the run has stopped for time. */
  readonly closed: () => boolean;
}

export function createDurationExtension(): DurationExtension {
  let grantedMs = 0;
  let isClosed = false;
  return {
    extraMs: () => grantedMs,
    add: (ms) => {
      grantedMs += ms;
    },
    close: () => {
      isClosed = true;
    },
    closed: () => isClosed,
  };
}
