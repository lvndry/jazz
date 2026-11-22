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
}

export function createDurationExtension(): DurationExtension {
  let grantedMs = 0;
  return {
    extraMs: () => grantedMs,
    add: (ms) => {
      grantedMs += ms;
    },
  };
}
