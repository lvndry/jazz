/**
 * TerminalOutputAdapter — encapsulates Ink Static/live tier logic.
 *
 * Centralizes:
 * - Two-tier rendering: Static (append-only scrollback) + live (current turn)
 * - Turn-based promotion: when a new "user" entry arrives, all previous
 *   live entries are promoted to Static (frozen, no longer re-laid-out)
 * - staticGeneration key on <Static> to reset on clear (ensures correct layout)
 *
 * This keeps the entire last response in the live area so it stays responsive
 * to terminal resize (Ink/Yoga re-layout on each frame). Once the user sends
 * a new message, the previous turn is frozen into Static where the terminal's
 * native soft-wrap handles any future resize.
 *
 * Future Ink migrations touch this file only.
 */

import { useCallback, useRef, useState } from "react";
import type { OutputEntry, OutputEntryWithId } from "../types";

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
    // A "user" entry marks the start of a new turn.
    // Promote everything currently in live to static so the previous
    // turn is frozen and the new turn starts fresh in the live area.
    if (entry.type === "user" && newLive.length > 0) {
      newStaticEntries = [...newStaticEntries, ...newLive];
      newLive = [];
    }

    newLive = [...newLive, entry];
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
