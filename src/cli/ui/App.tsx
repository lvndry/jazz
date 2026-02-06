import { Box, Static, useInput } from "ink";
import React, { useCallback, useRef, useState } from "react";
import { isActivityEqual, type ActivityState } from "./activity-state";
import { ActivityView } from "./ActivityView";
import { clearLastExpandedDiff, getLastExpandedDiff } from "./diff-expansion-store";
import ErrorBoundary from "./ErrorBoundary";
import { useInputHandler } from "./hooks/use-input-service";
import { LogEntryItem } from "./LogList";
import { Prompt } from "./Prompt";
import type { LogEntry, LogEntryInput, PromptState } from "./types";
import { InputPriority, InputResults } from "../services/input-service";

// ============================================================================
// Constants
// ============================================================================

const MAX_LOG_ENTRIES = 5000;

// ============================================================================
// Store - Global state setters (populated by islands)
// ============================================================================

type PrintOutputHandler = (entry: LogEntryInput) => string;

let printOutputHandler: PrintOutputHandler | null = null;
let clearLogsHandler: (() => void) | null = null;
const pendingLogQueue: LogEntryInput[] = [];
let pendingClear = false;
let pendingLogIdCounter = 0;

let promptSnapshot: PromptState | null = null;
let activitySnapshot: ActivityState = { phase: "idle" };
let workingDirectorySnapshot: string | null = null;

let promptSetter: ((prompt: PromptState | null) => void) | null = null;
let activitySetter: ((activity: ActivityState) => void) | null = null;
let workingDirectorySetter: ((workingDirectory: string | null) => void) | null = null;

export const store = {
  printOutput: (entry: LogEntryInput): string => {
    const id = entry.id ?? `queued-log-${++pendingLogIdCounter}`;
    const entryWithId = entry.id ? entry : { ...entry, id };

    if (!printOutputHandler) {
      pendingLogQueue.push(entryWithId);
      return id;
    }
    return printOutputHandler(entryWithId);
  },
  setPrompt: (prompt: PromptState | null): void => {
    promptSnapshot = prompt;
    if (promptSetter) {
      promptSetter(prompt);
    }
  },
  setActivity: (activity: ActivityState): void => {
    activitySnapshot = activity;
    if (activitySetter) {
      activitySetter(activity);
    }
  },
  setWorkingDirectory: (workingDirectory: string | null): void => {
    workingDirectorySnapshot = workingDirectory;
    if (workingDirectorySetter) {
      workingDirectorySetter(workingDirectory);
    }
  },
  setCustomView: (_view: React.ReactNode | null): void => {},
  setInterruptHandler: (_handler: (() => void) | null): void => {},
  clearLogs: (): void => {
    if (!clearLogsHandler) {
      pendingClear = true;
      pendingLogQueue.length = 0;
      return;
    }
    clearLogsHandler();
  },
};


// ============================================================================
// Activity Island - Unified state for status + streaming response
// ============================================================================

function ActivityIsland(): React.ReactElement | null {
  const [activity, setActivity] = useState<ActivityState>({ phase: "idle" });
  const initializedRef = useRef(false);

  // Register setter synchronously during render
  if (!initializedRef.current) {
    activitySetter = (next) => {
      setActivity((prev) => (isActivityEqual(prev, next) ? prev : next));
    };
    setActivity(activitySnapshot);
    initializedRef.current = true;
  }

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
    promptSetter = setPrompt;
    workingDirectorySetter = setWorkingDirectory;
    setPrompt(promptSnapshot);
    setWorkingDirectory(workingDirectorySnapshot);
    initializedRef.current = true;
  }

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
    printOutputHandler = printOutput;
    clearLogsHandler = clearLogs;
    if (pendingClear) {
      clearLogs();
      pendingClear = false;
    }
    if (pendingLogQueue.length > 0) {
      const queued = pendingLogQueue.splice(0, pendingLogQueue.length);
      for (const entry of queued) {
        printOutput(entry);
      }
    }
    initializedRef.current = true;
  }

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
    store.setCustomView = setCustomView;
    store.setInterruptHandler = (handler) => {
      interruptHandlerRef.current = handler;
    };
    initializedRef.current = true;
  }

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
        <Box flexDirection="column" paddingX={1} marginTop={1}>
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
