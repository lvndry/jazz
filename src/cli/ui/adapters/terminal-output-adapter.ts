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

import { useCallback, useState } from "react";
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

function processEntries(
  entries: readonly OutputEntry[],
  prev: TerminalOutputState,
): TerminalOutputState {
  let newLive = prev.liveEntries;
  let newStaticEntries = prev.staticEntries;
  let outputIdCounter = prev.outputIdCounter;

  for (const entry of entries) {
    const id = entry.id ?? `output-${outputIdCounter + 1}`;
    const entryWithId: OutputEntryWithId = { ...entry, id } as OutputEntryWithId;
    newLive = [...newLive, entryWithId];
    outputIdCounter += 1;

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
    outputIdCounter,
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

  const addEntry = useCallback((entryOrBatch: OutputEntry | readonly OutputEntry[]): string => {
    const entries: readonly OutputEntry[] = Array.isArray(entryOrBatch)
      ? entryOrBatch
      : [entryOrBatch];
    if (entries.length === 0) return "";

    const first = entries[0];
    const firstId: string = first?.id ?? "";
    setState((prev) => processEntries(entries, prev));
    return firstId;
  }, []);

  const clear = useCallback((): void => {
    setState((prev) => ({
      liveEntries: [],
      staticEntries: [],
      outputIdCounter: 0,
      staticGeneration: prev.staticGeneration + 1,
    }));
  }, []);

  return { state, addEntry, clear };
}
