import { Box, Static, useInput } from "ink";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { isActivityEqual, type ActivityState } from "./activity-state";
import { ActivityView } from "./ActivityView";
import ErrorBoundary from "./ErrorBoundary";
import { useInputHandler } from "./hooks/use-input-service";
import { OutputEntryView } from "./OutputEntryView";
import { Prompt } from "./Prompt";
import { store } from "./store";
import type { OutputEntry, OutputEntryWithId, PromptState } from "./types";
import { InputPriority, InputResults } from "../services/input-service";

// ============================================================================
// Constants
// ============================================================================

const MAX_OUTPUT_ENTRIES = 2000;

/**
 * Maximum entries kept in the live (non-Static) React tree.
 *
 * Ink re-runs Yoga layout over every node in the live area on each render
 * frame (keystrokes, spinner ticks, streaming updates, etc.). Keeping this
 * small ensures layout stays O(1) regardless of conversation length.
 *
 * Entries beyond this tail are promoted to Ink's <Static> region where they
 * are rendered to stdout exactly once and never re-laid-out.
 */
const LIVE_TAIL_SIZE = 50;

// ============================================================================
// Activity Island - Unified state for status + streaming response
// ============================================================================

function ActivityIsland(): React.ReactElement | null {
  const [activity, setActivity] = useState<ActivityState>({ phase: "idle" });
  const initializedRef = useRef(false);

  // Register setter synchronously during render
  if (!initializedRef.current) {
    store.registerActivitySetter((next) => {
      setActivity((prev) => (isActivityEqual(prev, next) ? prev : next));
    });
    setActivity(store.getActivitySnapshot());
    initializedRef.current = true;
  }

  // Cleanup on unmount to prevent stale setter calls
  useEffect(() => {
    return () => {
      store.registerActivitySetter(() => {});
    };
  }, []);

  if (activity.phase === "idle" || activity.phase === "complete") return null;

  return <ActivityView activity={activity} />;
}

// ============================================================================
// Prompt Island - Isolated state for user input prompt
// ============================================================================

function PromptIsland(): React.ReactElement | null {
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [workingDirectory, setWorkingDirectory] = useState<string | null>(null);
  const initializedRef = useRef(false);

  // Register setters synchronously during render
  if (!initializedRef.current) {
    store.registerPromptSetter(setPrompt);
    store.registerWorkingDirectorySetter(setWorkingDirectory);
    setPrompt(store.getPromptSnapshot());
    setWorkingDirectory(store.getWorkingDirectorySnapshot());
    initializedRef.current = true;
  }

  // Cleanup on unmount to prevent stale setter calls
  useEffect(() => {
    return () => {
      store.registerPromptSetter(() => {});
      store.registerWorkingDirectorySetter(() => {});
    };
  }, []);

  if (!prompt) return null;

  return (
    <Prompt
      prompt={prompt}
      workingDirectory={workingDirectory}
    />
  );
}

// ============================================================================
// Output Island - Isolated state for output entries
//
// Uses a two-tier rendering strategy for performance:
//
//   1. **Static tier** (Ink <Static>): entries that have scrolled out of the
//      recent tail. Ink renders these to stdout exactly once, then never
//      re-lays-out or diffs them again. This keeps Yoga's per-frame layout
//      cost independent of total conversation length.
//
//   2. **Live tier** (regular <Box>): the most recent `LIVE_TAIL_SIZE`
//      entries. Only these participate in Ink's render/layout cycle, so
//      keystroke latency stays constant even after thousands of messages.
//
// On `clearOutputs()` both tiers are reset (new arrays), avoiding the
// <Static> memory-leak concern from earlier revisions.
// ============================================================================

interface OutputIslandState {
  /** All entries ever added (source of truth, capped at MAX_OUTPUT_ENTRIES). */
  entries: OutputEntryWithId[];
  /** Entries committed to <Static> — Ink renders them once then ignores them. */
  staticEntries: OutputEntryWithId[];
  outputIdCounter: number;
}

function OutputIsland(): React.ReactElement {
  const [state, setState] = useState<OutputIslandState>({
    entries: [],
    staticEntries: [],
    outputIdCounter: 0,
  });
  const initializedRef = useRef(false);

  const printOutput = useCallback((entry: OutputEntry): string => {
    let newId = "";
    setState((prev) => {
      const id = entry.id ?? `output-${prev.outputIdCounter + 1}`;
      newId = id;

      const entryWithId: OutputEntryWithId = { ...entry, id } as OutputEntryWithId;

      // Append to full list, capping at MAX_OUTPUT_ENTRIES
      const newEntries =
        prev.entries.length >= MAX_OUTPUT_ENTRIES
          ? [...prev.entries.slice(1), entryWithId]
          : [...prev.entries, entryWithId];

      // Promote overflow beyond LIVE_TAIL_SIZE into the static tier.
      // Static entries are rendered by Ink exactly once (via <Static>),
      // then never re-laid-out, keeping per-frame cost O(LIVE_TAIL_SIZE).
      const overflow = newEntries.length - LIVE_TAIL_SIZE;
      const newStaticEntries =
        overflow > prev.staticEntries.length ? newEntries.slice(0, overflow) : prev.staticEntries;

      return {
        entries: newEntries,
        staticEntries: newStaticEntries,
        outputIdCounter: prev.outputIdCounter + 1,
      };
    });
    return newId;
  }, []);

  const clearOutputs = useCallback((): void => {
    setState({ entries: [], staticEntries: [], outputIdCounter: 0 });
  }, []);

  // Register store methods synchronously during render
  if (!initializedRef.current) {
    store.registerPrintOutput(printOutput);
    store.registerClearOutputs(clearOutputs);
    if (store.hasPendingClear()) {
      clearOutputs();
      store.consumePendingClear();
    }
    const queued = store.drainPendingOutputQueue();
    for (const entry of queued) {
      printOutput(entry);
    }
    initializedRef.current = true;
  }

  // Cleanup on unmount to prevent stale handler calls
  useEffect(() => {
    return () => {
      store.registerPrintOutput(() => "");
      store.registerClearOutputs(() => {});
    };
  }, []);

  // Live tail: only the most recent entries participate in Ink's render cycle.
  const liveTail = state.entries.slice(state.staticEntries.length);

  return (
    <Box flexDirection="column">
      {/* Static tier: rendered once, never re-laid-out */}
      <Static items={state.staticEntries}>
        {(entry, index) => {
          const prevEntry = index > 0 ? state.staticEntries[index - 1] : null;
          const addSpacing =
            entry.type === "user" || (entry.type === "info" && prevEntry?.type === "user");
          return (
            <OutputEntryView
              key={entry.id}
              entry={entry}
              addSpacing={addSpacing}
            />
          );
        }}
      </Static>

      {/* Live tier: re-rendered on each frame, kept small for performance */}
      {liveTail.map((entry, index) => {
        // For spacing, check against the last static entry if this is the first live entry
        const prevEntry =
          index > 0
            ? liveTail[index - 1]
            : state.staticEntries.length > 0
              ? state.staticEntries[state.staticEntries.length - 1]
              : null;
        const addSpacing =
          entry.type === "user" || (entry.type === "info" && prevEntry?.type === "user");
        return (
          <OutputEntryView
            key={entry.id}
            entry={entry}
            addSpacing={addSpacing}
          />
        );
      })}
    </Box>
  );
}

// ============================================================================
// Main App Component
// ============================================================================

export function App(): React.ReactElement {
  const [customView, setCustomView] = useState<React.ReactNode | null>(null);
  const interruptHandlerRef = useRef<(() => void) | null>(null);
  const initializedRef = useRef(false);

  // Setup store methods synchronously during render
  if (!initializedRef.current) {
    store.registerCustomView(setCustomView);
    store.registerInterruptHandler((handler) => {
      interruptHandlerRef.current = handler;
    });
    initializedRef.current = true;
  }

  // Cleanup on unmount to prevent stale handler calls
  useEffect(() => {
    return () => {
      store.registerCustomView(() => {});
      store.registerInterruptHandler(() => {});
    };
  }, []);

  // Handle Ctrl+C — bridge from Ink raw mode to process SIGINT
  // With exitOnCtrlC: false, Ink forwards Ctrl+C to useInput instead of
  // swallowing it. We raise a real SIGINT so the handler in app-layer.ts fires.
  useInput((input, key) => {
    if (input === "c" && key.ctrl) {
      process.kill(process.pid, "SIGINT");
    }
  });

  // Handle interrupt (Ctrl+I / Tab)
  useInput((input, key) => {
    const isTabOrCtrlI = key.tab || input === "\t" || input.charCodeAt(0) === 9;
    if (isTabOrCtrlI && interruptHandlerRef.current) {
      interruptHandlerRef.current();
    }
  });

  // Handle expand-diff shortcut
  useInputHandler({
    id: "expand-diff-handler",
    priority: InputPriority.GLOBAL_SHORTCUT,
    onInput: (action) => {
      if (action.type !== "expand-diff") {
        return InputResults.ignored();
      }

      const payload = store.getExpandableDiff();
      if (!payload) {
        store.printOutput({
          type: "warn",
          message: "No truncated diff available to expand.",
          timestamp: new Date(),
        });
        return InputResults.consumed();
      }

      store.printOutput({
        type: "log",
        message: payload.fullDiff,
        timestamp: new Date(),
      });
      store.clearExpandableDiff();
      return InputResults.consumed();
    },
    deps: [],
  });

  return (
    <ErrorBoundary>
      {customView}
      <Box
        flexDirection="column"
        display={customView ? "none" : "flex"}
      >
        {/* Main Chat Area */}
        <Box
          flexDirection="column"
          paddingX={3}
          marginTop={1}
        >
          {/* Output entries - Isolated state, cleared on terminal.clear() */}
          <OutputIsland />

          {/* Activity - Unified status + streaming response */}
          <ActivityIsland />

          {/* User input prompt - Isolated state */}
          <PromptIsland />
        </Box>
      </Box>
    </ErrorBoundary>
  );
}

export default App;
