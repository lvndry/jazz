/**
 * Scrollback buffer — the streaming output tier model.
 *
 * Centralizes:
 * - Append-only scrollback via <Static>: every settled entry is written to the
 *   terminal exactly once and never re-rendered.
 * - A single optional pending streaming buffer rendered as one <Text> node in
 *   Ink's live (erasable) region.
 * - Markdown-aware split-and-promote: as the pending tail grows, settled
 *   prefixes are promoted to Static at safe markdown boundaries. The live
 *   region's height stays bounded regardless of total response length.
 *
 * Design rule: the live tier holds at most one pending streaming buffer.
 * Every other entry — info/log/debug/error/warn/user/tool cards/headers/
 * metrics/cost — is settled at emit time and goes straight to Static.
 *
 * Backward-compatibility: `useTerminalOutputAdapter` still exposes a
 * legacy `addEntry` shim that routes through `appendStatic`. This is in place
 * to keep existing call sites in `InkStreamingRenderer` working until that
 * file is rewritten in a later task. The shim is dropped in Task 8.
 */

import { useCallback, useEffect, useReducer, useRef } from "react";
import { findLastSafeSplitPoint } from "@/cli/presentation/markdown-split";
import type { OutputEntry, OutputEntryWithId } from "../types";

export type { OutputEntry, OutputEntryWithId };

export type StreamKind = "response" | "reasoning";

export interface PendingStream {
  readonly id: string;
  readonly kind: StreamKind;
  readonly rawTail: string;
}

export interface ScrollbackState {
  readonly staticEntries: OutputEntryWithId[];
  readonly pending: PendingStream | null;
  /** Bumped on clear; used as the key on <Static> to force remount. */
  readonly staticGeneration: number;
}

export type ScrollbackAction =
  | { type: "appendStatic"; entries: readonly OutputEntryWithId[] }
  | {
      type: "appendStream";
      kind: StreamKind;
      delta: string;
      /** Pre-allocated id for a newly-opened pending. Caller owns id generation. */
      nextId: string;
      /** Pre-allocated id for the streamContent entry produced when the prior
       *  pending of a different kind is auto-finalized. */
      finalizeId?: string;
    }
  | { type: "finalizeStream"; finalizeId?: string }
  | { type: "clear" };

export function initialScrollbackState(): ScrollbackState {
  return {
    staticEntries: [],
    pending: null,
    staticGeneration: 0,
  };
}

export function reduceScrollback(
  state: ScrollbackState,
  action: ScrollbackAction,
): ScrollbackState {
  switch (action.type) {
    case "appendStatic": {
      if (action.entries.length === 0) return state;
      return {
        ...state,
        staticEntries: [...state.staticEntries, ...action.entries],
      };
    }

    case "appendStream": {
      let next = state;

      // Kind change → finalize prior pending first.
      if (next.pending !== null && next.pending.kind !== action.kind) {
        next = reduceScrollback(next, {
          type: "finalizeStream",
          ...(action.finalizeId !== undefined ? { finalizeId: action.finalizeId } : {}),
        });
      }

      // Open or extend the current pending.
      if (next.pending === null) {
        next = {
          ...next,
          pending: { id: action.nextId, kind: action.kind, rawTail: action.delta },
        };
      } else {
        next = {
          ...next,
          pending: { ...next.pending, rawTail: next.pending.rawTail + action.delta },
        };
      }

      // Try split-and-promote.
      return splitAndPromote(next);
    }

    case "finalizeStream": {
      if (state.pending === null) return state;
      const id = action.finalizeId ?? `${state.pending.id}-final`;
      const slice: OutputEntryWithId = {
        id,
        type: "streamContent",
        message: state.pending.rawTail,
        meta: { kind: state.pending.kind },
        timestamp: new Date(),
      };
      return {
        ...state,
        staticEntries: [...state.staticEntries, slice],
        pending: null,
      };
    }

    case "clear": {
      return {
        staticEntries: [],
        pending: null,
        staticGeneration: state.staticGeneration + 1,
      };
    }
  }
}

/**
 * Promote any safely-splittable prefix of the pending tail to Static. No-op
 * when no safe split exists.
 */
function splitAndPromote(state: ScrollbackState): ScrollbackState {
  if (state.pending === null) return state;
  let splitOffset: number;
  try {
    splitOffset = findLastSafeSplitPoint(state.pending.rawTail);
  } catch {
    // Splitter threw: degrade safely, leave pending untouched.
    return state;
  }
  if (splitOffset <= 0) return state;

  const before = state.pending.rawTail.slice(0, splitOffset);
  const after = state.pending.rawTail.slice(splitOffset);
  const promoted: OutputEntryWithId = {
    id: `${state.pending.id}-${state.staticEntries.length}`,
    type: "streamContent",
    message: before,
    meta: { kind: state.pending.kind },
    timestamp: new Date(),
  };
  return {
    ...state,
    staticEntries: [...state.staticEntries, promoted],
    pending: { ...state.pending, rawTail: after },
  };
}

// ---------------------------------------------------------------------------
// React hook — thin wrapper around the pure reducer.
// ---------------------------------------------------------------------------

export interface ScrollbackHandle {
  state: ScrollbackState;
  /** Append a single entry or batch to the static (scrollback) tier. */
  appendStatic: (entry: OutputEntry | readonly OutputEntry[]) => string;
  /** Feed a raw text delta into the pending streaming buffer. */
  appendStream: (kind: StreamKind, delta: string) => void;
  /** Promote any open pending to Static and clear it. */
  finalizeStream: () => void;
  /** Reset the buffer (used by the /clear slash command). */
  clear: () => void;
  /**
   * Backward-compat shim. Routes through `appendStatic`. Returns the first
   * entry's id. Will be removed in Task 8.
   */
  addEntry: (entry: OutputEntry | readonly OutputEntry[]) => string;
}

export function useTerminalOutputAdapter(): ScrollbackHandle {
  const [state, dispatch] = useReducer(reduceScrollback, initialScrollbackState());
  const counterRef = useRef(0);

  const nextId = useCallback((): string => {
    counterRef.current += 1;
    return `output-${counterRef.current}`;
  }, []);

  const ensureIds = useCallback(
    (input: OutputEntry | readonly OutputEntry[]): OutputEntryWithId[] => {
      const list: readonly OutputEntry[] = Array.isArray(input) ? input : [input];
      return list.map((entry) =>
        entry.id != null ? (entry as OutputEntryWithId) : { ...entry, id: nextId() },
      );
    },
    [nextId],
  );

  const appendStatic = useCallback(
    (entry: OutputEntry | readonly OutputEntry[]): string => {
      const entries = ensureIds(entry);
      if (entries.length === 0) return "";
      dispatch({ type: "appendStatic", entries });
      return entries[0]!.id;
    },
    [ensureIds],
  );

  // Mirrors state.pending so appendStream can check for kind changes without
  // reading state inside a useCallback closure (stale closure hazard).
  const pendingRef = useRef<PendingStream | null>(null);
  useEffect(() => {
    pendingRef.current = state.pending;
  }, [state.pending]);

  const appendStream = useCallback(
    (kind: StreamKind, delta: string): void => {
      if (delta.length === 0) return;
      const needsFinalize = pendingRef.current !== null && pendingRef.current.kind !== kind;
      dispatch({
        type: "appendStream",
        kind,
        delta,
        nextId: nextId(),
        ...(needsFinalize ? { finalizeId: nextId() } : {}),
      });
    },
    [nextId],
  );

  const finalizeStream = useCallback((): void => {
    dispatch({ type: "finalizeStream", finalizeId: nextId() });
  }, [nextId]);

  const clear = useCallback((): void => {
    counterRef.current = 0;
    dispatch({ type: "clear" });
  }, []);

  // Compat shim — drops in Task 8.
  const addEntry = appendStatic;

  return {
    state,
    appendStatic,
    appendStream,
    finalizeStream,
    clear,
    addEntry,
  };
}
