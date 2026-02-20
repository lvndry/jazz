/**
 * TerminalOutputAdapter — encapsulates Ink Static/live tier logic.
 *
 * Centralizes:
 * - Two-tier rendering: Static (append-only scrollback) + live (last N entries)
 * - LIVE_TAIL_SIZE promotion from live to Static
 * - staticGeneration key on <Static> to reset on clear (ensures correct layout)
 *
 * Future Ink migrations touch this file only.
 */

import { useCallback, useRef, useState } from "react";
import type { OutputEntry, OutputEntryWithId } from "../types";

/**
 * Maximum entries kept in the live (non-Static) React tree.
 *
 * Ink re-runs Yoga layout over every node in the live area on each render
 * frame. Keeping this small ensures layout stays O(1) regardless of
 * conversation length. Entries beyond this are promoted to Static.
 */
export const LIVE_TAIL_SIZE = 15;

export interface TerminalOutputState {
  readonly liveEntries: OutputEntryWithId[];
  readonly staticEntries: OutputEntryWithId[];
  readonly outputIdCounter: number;
  /** Bumped on clear; used as key on <Static> to force remount for correct layout. */
  readonly staticGeneration: number;
}

function assignEntryIds(
  entries: readonly OutputEntry[],
  startCounter: number,
): {
  entriesWithId: OutputEntryWithId[];
  firstId: string;
  nextCounter: number;
} {
  let counter = startCounter;
  const entriesWithId = entries.map((entry) => {
    const id = entry.id ?? `output-${counter + 1}`;
    counter += 1;
    return { ...entry, id };
  });
  const firstId = entriesWithId[0]?.id ?? "";
  return { entriesWithId, firstId, nextCounter: counter };
}

function processEntries(
  entries: readonly OutputEntryWithId[],
  prev: TerminalOutputState,
  nextOutputIdCounter: number,
): TerminalOutputState {
  let newLive = prev.liveEntries;
  let newStaticEntries = prev.staticEntries;

  for (const entry of entries) {
    newLive = [...newLive, entry];

    if (newLive.length > LIVE_TAIL_SIZE) {
      const overflow = newLive.length - LIVE_TAIL_SIZE;
      const promoted = newLive.slice(0, overflow);
      newLive = newLive.slice(overflow);
      newStaticEntries = [...newStaticEntries, ...promoted];
    }
  }

  return {
    liveEntries: newLive,
    staticEntries: newStaticEntries,
    outputIdCounter: nextOutputIdCounter,
    staticGeneration: prev.staticGeneration,
  };
}

/**
 * Hook that encapsulates the two-tier Static/live output logic.
 * Returns state and handlers for the store to register.
 * Supports batch adds for coalesced updates.
 */
export function useTerminalOutputAdapter(): {
  state: TerminalOutputState;
  addEntry: (entry: OutputEntry | readonly OutputEntry[]) => string;
  clear: () => void;
} {
  const [state, setState] = useState<TerminalOutputState>({
    liveEntries: [],
    staticEntries: [],
    outputIdCounter: 0,
    staticGeneration: 0,
  });
  const outputIdCounterRef = useRef(0);

  const addEntry = useCallback((entryOrBatch: OutputEntry | readonly OutputEntry[]): string => {
    const entries: readonly OutputEntry[] = Array.isArray(entryOrBatch)
      ? entryOrBatch
      : [entryOrBatch];
    if (entries.length === 0) return "";

    const { entriesWithId, firstId, nextCounter } = assignEntryIds(
      entries,
      outputIdCounterRef.current,
    );
    outputIdCounterRef.current = nextCounter;
    setState((prev) => processEntries(entriesWithId, prev, nextCounter));
    return firstId;
  }, []);

  const clear = useCallback((): void => {
    outputIdCounterRef.current = 0;
    setState((prev) => ({
      liveEntries: [],
      staticEntries: [],
      outputIdCounter: 0,
      staticGeneration: prev.staticGeneration + 1,
    }));
  }, []);

  return { state, addEntry, clear };
}
