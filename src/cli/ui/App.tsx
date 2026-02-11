import { Box, useInput } from "ink";
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
// Renders entries as regular Box children so they are truly removed on clear,
// avoiding Ink's <Static> internal accumulation that causes memory leaks.
// ============================================================================

interface OutputIslandState {
  entries: OutputEntryWithId[];
  outputIdCounter: number;
}

function OutputIsland(): React.ReactElement {
  const [state, setState] = useState<OutputIslandState>({
    entries: [],
    outputIdCounter: 0,
  });
  const initializedRef = useRef(false);

  const printOutput = useCallback((entry: OutputEntry): string => {
    let newId = "";
    setState((prev) => {
      const id = entry.id ?? `output-${prev.outputIdCounter + 1}`;
      newId = id;

      const entryWithId: OutputEntryWithId = { ...entry, id } as OutputEntryWithId;
      const newEntries =
        prev.entries.length >= MAX_OUTPUT_ENTRIES
          ? [...prev.entries.slice(1), entryWithId]
          : [...prev.entries, entryWithId];

      return {
        entries: newEntries,
        outputIdCounter: prev.outputIdCounter + 1,
      };
    });
    return newId;
  }, []);

  const clearOutputs = useCallback((): void => {
    setState({ entries: [], outputIdCounter: 0 });
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
      {state.entries.map((entry, index) => {
        const prevEntry = index > 0 ? state.entries[index - 1] : null;
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
