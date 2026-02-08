import { Box, Static, useInput } from "ink";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { isActivityEqual, type ActivityState } from "./activity-state";
import { ActivityView } from "./ActivityView";
import { clearLastExpandedDiff, getLastExpandedDiff } from "./diff-expansion-store";
import ErrorBoundary from "./ErrorBoundary";
import { useInputHandler } from "./hooks/use-input-service";
import { LogEntryItem } from "./LogList";
import { Prompt } from "./Prompt";
import { store } from "./store";
import type { LogEntry, LogEntryInput, PromptState } from "./types";
import { InputPriority, InputResults } from "../services/input-service";

// ============================================================================
// Constants
// ============================================================================

const MAX_LOG_ENTRIES = 2000;

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
    return () => { store.registerActivitySetter(() => {}); };
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

  return <Prompt prompt={prompt} workingDirectory={workingDirectory} />;
}

// ============================================================================
// Log Island - Isolated state for log entries
// Uses Static for finalized logs (Ink won't re-render them)
// ============================================================================

interface LogIslandState {
  logs: LogEntry[];
  logIdCounter: number;
}

function LogIsland(): React.ReactElement {
  const [state, setState] = useState<LogIslandState>({
    logs: [],
    logIdCounter: 0,
  });
  const initializedRef = useRef(false);

  const printOutput = useCallback((entry: LogEntryInput): string => {
    let newId = "";
    setState((prev) => {
      const id = entry.id ?? `log-${prev.logIdCounter + 1}`;
      newId = id;

      const entryWithId: LogEntry = { ...entry, id } as LogEntry;
      const newLogs =
        prev.logs.length >= MAX_LOG_ENTRIES
          ? [...prev.logs.slice(1), entryWithId]
          : [...prev.logs, entryWithId];

      return {
        logs: newLogs,
        logIdCounter: prev.logIdCounter + 1,
      };
    });
    return newId;
  }, []);

  const clearLogs = useCallback((): void => {
    setState({ logs: [], logIdCounter: 0 });
  }, []);

  // Register store methods synchronously during render
  if (!initializedRef.current) {
    store.registerPrintOutput(printOutput);
    store.registerClearLogs(clearLogs);
    if (store.hasPendingClear()) {
      clearLogs();
      store.consumePendingClear();
    }
    const queued = store.drainPendingLogQueue();
    for (const entry of queued) {
      printOutput(entry);
    }
    initializedRef.current = true;
  }

  // Cleanup on unmount to prevent stale handler calls
  useEffect(() => {
    return () => {
      store.registerPrintOutput(() => "");
      store.registerClearLogs(() => {});
    };
  }, []);

  return (
    <>
      {/* All logs rendered via Static — Ink paints each once and never re-renders them */}
      {state.logs.length > 0 && (
        <Static items={state.logs}>
          {(log, index) => {
            const prevLog = index > 0 ? state.logs[index - 1] : null;
            const addSpacing =
              log.type === "user" ||
              (log.type === "info" && prevLog?.type === "user");
            return (
              <React.Fragment key={log.id}>
                <LogEntryItem
                  log={log}
                  addSpacing={addSpacing}
                />
              </React.Fragment>
            );
          }}
        </Static>
      )}
    </>
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

      const payload = getLastExpandedDiff();
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
      clearLastExpandedDiff();
      return InputResults.consumed();
    },
    deps: [],
  });

  if (customView) {
    return <ErrorBoundary>{customView}</ErrorBoundary>;
  }

  return (
    <ErrorBoundary>
      <Box flexDirection="column">
        {/* Main Chat Area */}
        <Box flexDirection="column" paddingX={3} marginTop={1}>
          {/* Logs - Isolated state with Static optimization */}
          <LogIsland />

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
