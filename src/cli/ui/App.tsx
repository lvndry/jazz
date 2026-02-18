import { Box, Static, Text, useInput } from "ink";
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

/**
 * Maximum entries kept in the live (non-Static) React tree.
 *
 * Ink re-runs Yoga layout over every node in the live area on each render
 * frame (keystrokes, spinner ticks, streaming updates, etc.). Keeping this
 * small ensures layout stays O(1) regardless of conversation length.
 *
 * Entries beyond this tail are promoted to Ink's <Static> region where they
 * are rendered to stdout exactly once and never re-laid-out.
 *
 * Chosen as 15 for performance: fewer live nodes means
 * faster layout recompute on each keystroke/stream tick. Trade-off: less
 * recent context visible in the scrollback before it promotes to Static.
 */
const LIVE_TAIL_SIZE = 15;

// ============================================================================
// Activity Island - Unified state for status + streaming response
// ============================================================================

function ActivityIslandComponent(): React.ReactElement | null {
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

const ActivityIsland = React.memo(ActivityIslandComponent);

// ============================================================================
// Prompt Island - Isolated state for user input prompt
// ============================================================================

function PromptIslandComponent(): React.ReactElement | null {
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

const PromptIsland = React.memo(PromptIslandComponent);

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
// On `clearOutputs()` both tiers are reset (new arrays) and the
// `staticGeneration` counter is bumped, which changes the React `key`
// on `<Static>`.  This forces a full remount, resetting Ink's internal
// positional index so that post-clear items are rendered correctly.
// Without the remount, Ink's `<Static>` would still remember the old
// item count and silently drop newly promoted entries (see detailed
// explanation on the `staticGeneration` field).
// ============================================================================

interface OutputIslandState {
  /**
   * Live tail entries — only these participate in Ink's render/layout cycle.
   * Capped at LIVE_TAIL_SIZE. When overflow occurs, entries are promoted
   * to `staticEntries` (append-only) where Ink renders them exactly once.
   */
  liveEntries: OutputEntryWithId[];
  /**
   * Append-only array fed to Ink's <Static>.  Items are only ever pushed
   * onto the end — never shifted or spliced — so <Static>'s internal
   * index-based tracking stays correct.
   */
  staticEntries: OutputEntryWithId[];
  outputIdCounter: number;
  /**
   * Monotonically increasing generation counter, bumped on every
   * `clearOutputs()` call. Used as the React `key` on `<Static>` to
   * force a full remount, which resets Ink's internal positional index
   * back to 0.
   *
   * Why this is necessary: Ink's `<Static>` tracks how many items it
   * has already rendered via a `useState(0)` counter (`index`). It only
   * renders `items.slice(index)` — i.e., items appended since the last
   * render. When we clear `staticEntries` back to `[]`, React may batch
   * the clear with subsequent promotions, causing the *first* render
   * after the clear to see a short array while `index` still equals the
   * old (larger) count. `items.slice(oldIndex)` on the short array
   * yields `[]`, silently dropping newly promoted items. Changing the
   * `key` forces React to unmount and remount `<Static>`, resetting
   * `index` to 0 so all post-clear items are rendered correctly.
   */
  staticGeneration: number;
}

function OutputIslandComponent(): React.ReactElement {
  const [state, setState] = useState<OutputIslandState>({
    liveEntries: [],
    staticEntries: [],
    outputIdCounter: 0,
    staticGeneration: 0,
  });
  const initializedRef = useRef(false);

  const printOutput = useCallback((entry: OutputEntry): string => {
    let newId = "";
    setState((prev) => {
      const id = entry.id ?? `output-${prev.outputIdCounter + 1}`;
      newId = id;

      const entryWithId: OutputEntryWithId = { ...entry, id } as OutputEntryWithId;
      const newLive = [...prev.liveEntries, entryWithId];

      // When the live tail exceeds LIVE_TAIL_SIZE, promote the oldest
      // entries to the static tier (append-only, rendered once by <Static>).
      let newStaticEntries = prev.staticEntries;
      let trimmedLive = newLive;

      if (newLive.length > LIVE_TAIL_SIZE) {
        const overflow = newLive.length - LIVE_TAIL_SIZE;
        const promoted = newLive.slice(0, overflow);
        trimmedLive = newLive.slice(overflow);
        newStaticEntries = [...prev.staticEntries, ...promoted];
      }

      // Note: we intentionally do NOT trim staticEntries from the front.
      // Ink's <Static> tracks rendered items by positional index; any
      // shift would cause it to skip newly promoted items.  The array
      // only holds small objects (just references, not Yoga nodes), so
      // the memory cost is negligible compared to the layout savings.

      return {
        liveEntries: trimmedLive,
        staticEntries: newStaticEntries,
        outputIdCounter: prev.outputIdCounter + 1,
        staticGeneration: prev.staticGeneration,
      };
    });
    return newId;
  }, []);

  const clearOutputs = useCallback((): void => {
    setState((prev) => ({
      liveEntries: [],
      staticEntries: [],
      outputIdCounter: 0,
      staticGeneration: prev.staticGeneration + 1,
    }));
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

  return (
    <Box flexDirection="column">
      {/* Static tier: rendered once, never re-laid-out.
          The key forces a remount on clearOutputs(), resetting Ink's
          internal positional index so post-clear items render correctly. */}
      <Static
        key={state.staticGeneration}
        items={state.staticEntries}
      >
        {(entry: OutputEntryWithId, index: number) => {
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
      {state.liveEntries.map((entry, index) => {
        // For spacing, check against the last static entry if this is the first live entry
        const prevEntry =
          index > 0
            ? state.liveEntries[index - 1]
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

const OutputIsland = React.memo(OutputIslandComponent);

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

  // Handle interrupt (double-tap Escape)
  const lastEscapeRef = useRef<number>(0);
  const escapeHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showEscapeHint, setShowEscapeHint] = useState(false);
  const DOUBLE_ESCAPE_WINDOW_MS = 1000;

  useInput((input, key) => {
    const isEscape = key.escape || input === "\x1b";
    if (!isEscape || !interruptHandlerRef.current) {
      return;
    }

    const now = Date.now();
    const elapsed = now - lastEscapeRef.current;
    lastEscapeRef.current = now;

    if (elapsed <= DOUBLE_ESCAPE_WINDOW_MS && showEscapeHint) {
      // Second press — interrupt generation
      lastEscapeRef.current = 0;
      setShowEscapeHint(false);
      if (escapeHintTimerRef.current) {
        clearTimeout(escapeHintTimerRef.current);
        escapeHintTimerRef.current = null;
      }
      interruptHandlerRef.current();
    } else {
      // First press — show hint, auto-dismiss after timeout
      setShowEscapeHint(true);
      if (escapeHintTimerRef.current) {
        clearTimeout(escapeHintTimerRef.current);
      }
      escapeHintTimerRef.current = setTimeout(() => {
        setShowEscapeHint(false);
        escapeHintTimerRef.current = null;
      }, DOUBLE_ESCAPE_WINDOW_MS);
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

          {/* Escape interrupt hint - shown after first Esc during generation */}
          {showEscapeHint && (
            <Box paddingX={2}>
              <Text color="red">Press Esc again to interrupt generation</Text>
            </Box>
          )}

          {/* User input prompt - Isolated state */}
          <PromptIsland />
        </Box>
      </Box>
    </ErrorBoundary>
  );
}

export default App;
