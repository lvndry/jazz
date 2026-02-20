import { Box, Static, Text, useInput } from "ink";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { isActivityEqual, type ActivityState } from "./activity-state";
import { ActivityView } from "./ActivityView";
import { useTerminalOutputAdapter } from "./adapters/terminal-output-adapter";
import ErrorBoundary from "./ErrorBoundary";
import { useInputHandler } from "./hooks/use-input-service";
import { OutputEntryView } from "./OutputEntryView";
import { Prompt } from "./Prompt";
import { store } from "./store";
import type { OutputEntryWithId, PromptState } from "./types";
import { InputPriority, InputResults } from "../services/input-service";

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
// Uses TerminalOutputAdapter for two-tier Static/live rendering.
// ============================================================================

function OutputIslandComponent(): React.ReactElement {
  const { state, addEntry, clear } = useTerminalOutputAdapter();
  const initializedRef = useRef(false);

  const printOutput = useCallback(
    (entryOrBatch: Parameters<typeof addEntry>[0]) => addEntry(entryOrBatch),
    [addEntry],
  );

  const clearOutputs = useCallback(() => clear(), [clear]);

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
  // Use a ref for synchronous read in the input handler (React state updates are async
  // and would cause the second ESC press to always see showEscapeHint === false).
  const escapeHintActiveRef = useRef(false);
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

    if (elapsed <= DOUBLE_ESCAPE_WINDOW_MS && escapeHintActiveRef.current) {
      // Second press — interrupt generation
      lastEscapeRef.current = 0;
      escapeHintActiveRef.current = false;
      setShowEscapeHint(false);
      if (escapeHintTimerRef.current) {
        clearTimeout(escapeHintTimerRef.current);
        escapeHintTimerRef.current = null;
      }
      interruptHandlerRef.current();
    } else {
      // First press — show hint, auto-dismiss after timeout
      escapeHintActiveRef.current = true;
      setShowEscapeHint(true);
      if (escapeHintTimerRef.current) {
        clearTimeout(escapeHintTimerRef.current);
      }
      escapeHintTimerRef.current = setTimeout(() => {
        escapeHintActiveRef.current = false;
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
          <ErrorBoundary fallback={<Text color="red">Output area error. Restart may help.</Text>}>
            <OutputIsland />
          </ErrorBoundary>

          {/* Activity - Unified status + streaming response */}
          <ErrorBoundary fallback={<Text color="red">Activity area error. Restart may help.</Text>}>
            <ActivityIsland />
          </ErrorBoundary>

          {/* Escape interrupt hint - shown after first Esc during generation */}
          {showEscapeHint && (
            <Box paddingX={2}>
              <Text color="red">Press Esc again to interrupt generation</Text>
            </Box>
          )}

          {/* User input prompt - Isolated state */}
          <ErrorBoundary fallback={<Text color="red">Prompt area error. Restart may help.</Text>}>
            <PromptIsland />
          </ErrorBoundary>
        </Box>
      </Box>
    </ErrorBoundary>
  );
}

export default App;
