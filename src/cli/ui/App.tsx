import { Box, Static, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import React, { useCallback, useRef, useState } from "react";
import { clearLastExpandedDiff, getLastExpandedDiff } from "./diff-expansion-store";
import ErrorBoundary from "./ErrorBoundary";
import { useInputHandler } from "./hooks/use-input-service";
import { LiveResponse } from "./LiveResponse";
import { LogEntryItem } from "./LogList";
import { Prompt } from "./Prompt";
import type { LiveStreamState, LogEntry, LogEntryInput, PromptState } from "./types";
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
let statusSnapshot: string | null = null;
let streamSnapshot: LiveStreamState | null = null;
let workingDirectorySnapshot: string | null = null;

let promptSetter: ((prompt: PromptState | null) => void) | null = null;
let statusSetter: ((status: string | null) => void) | null = null;
let streamSetter: ((stream: LiveStreamState | null) => void) | null = null;
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
  setStatus: (status: string | null): void => {
    statusSnapshot = status;
    if (statusSetter) {
      statusSetter(status);
    }
  },
  setStream: (stream: LiveStreamState | null): void => {
    streamSnapshot = stream;
    if (streamSetter) {
      streamSetter(stream);
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
// Status Island - Isolated state for status bar
// ============================================================================

function StatusIsland(): React.ReactElement | null {
  const [status, setStatus] = useState<string | null>(null);
  const initializedRef = useRef(false);

  // Register setter synchronously during render
  if (!initializedRef.current) {
    statusSetter = setStatus;
    setStatus(statusSnapshot);
    initializedRef.current = true;
  }

  if (!status) return null;

  return (
    <Box paddingX={2} marginTop={1}>
      <Text color="yellow">
        <Spinner type="dots" />
      </Text>
      <Text color="yellow"> {status}</Text>
    </Box>
  );
}

// ============================================================================
// Stream Island - Isolated state for live streaming response
// ============================================================================

function isSameStream(
  previous: LiveStreamState | null,
  next: LiveStreamState | null,
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return false;
  return (
    previous.agentName === next.agentName &&
    previous.text === next.text &&
    previous.reasoning === next.reasoning &&
    previous.isThinking === next.isThinking
  );
}

function StreamIsland(): React.ReactElement | null {
  const [stream, setStream] = useState<LiveStreamState | null>(null);
  const initializedRef = useRef(false);

  // Register setter synchronously during render
  if (!initializedRef.current) {
    streamSetter = (nextStream) => {
      setStream((prev) => isSameStream(prev, nextStream) ? prev : nextStream);
    };
    setStream(streamSnapshot);
    initializedRef.current = true;
  }

  if (!stream) return null;

  return <LiveResponse stream={stream} />;
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

          {/* Status Bar - below last message, above live stream */}
          <StatusIsland />

          {/* Live streaming response - Isolated state */}
          <StreamIsland />

          {/* User input prompt - Isolated state */}
          <PromptIsland />
        </Box>
      </Box>
    </ErrorBoundary>
  );
}

export default App;
