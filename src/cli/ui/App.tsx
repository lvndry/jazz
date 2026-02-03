import { Box, Static, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import React, { useCallback, useMemo, useRef, useState } from "react";
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

const MAX_LOG_ENTRIES = 100;
/** Number of recent logs to keep dynamic (not in Static) */
const DYNAMIC_LOG_COUNT = 10;

// ============================================================================
// Store - Global state setters (populated by islands)
// ============================================================================

type PrintOutputHandler = (entry: LogEntryInput) => string;
type UpdateOutputHandler = (id: string, entry: Partial<LogEntryInput>) => void;

let printOutputHandler: PrintOutputHandler | null = null;
let updateOutputHandler: UpdateOutputHandler | null = null;
let clearLogsHandler: (() => void) | null = null;
const pendingLogQueue: LogEntryInput[] = [];
const pendingUpdates: Array<{ id: string; updates: Partial<LogEntryInput> }> = [];
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
  updateOutput: (id: string, entry: Partial<LogEntryInput>): void => {
    if (!updateOutputHandler) {
      pendingUpdates.push({ id, updates: entry });
      return;
    }
    updateOutputHandler(id, entry);
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
      pendingUpdates.length = 0;
      return;
    }
    clearLogsHandler();
  },
};

// ============================================================================
// Lightweight Header - Always used (no expensive BigText/Gradient)
// ============================================================================

/**
 * Minimal header - avoids expensive BigText/Gradient for better performance.
 */
const AppHeader = React.memo(function AppHeader(): React.ReactElement {
  return (
    <Box
      paddingX={2}
      paddingY={1}
      borderStyle="round"
      borderColor="cyan"
    >
      <Text bold color="cyan">🎷 Jazz</Text>
      <Text dimColor> • Agentic CLI</Text>
    </Box>
  );
}, () => true); // Never re-render - content is static

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
    previous.reasoning === next.reasoning
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

  // Memoize log operations
  const printOutput = useCallback((entry: LogEntryInput): string => {
    let newId = "";
    setState((prev) => {
      const id = entry.id ?? `log-${prev.logIdCounter + 1}`;
      newId = id;

      // Check for update to existing log
      if (entry.id && prev.logs.some((log) => log.id === entry.id)) {
        return {
          ...prev,
          logs: prev.logs.map((log): LogEntry => {
            if (log.id === entry.id) {
              return { ...log, ...entry, id } as LogEntry;
            }
            return log;
          }),
        };
      }

      // Add new log
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

  const updateOutput = useCallback((id: string, updates: Partial<LogEntryInput>): void => {
    setState((prev) => ({
      ...prev,
      logs: prev.logs.map((log): LogEntry => {
        if (log.id !== id) return log;

        const next = { ...log, ...updates } as LogEntry;
        const isSame =
          log.type === next.type &&
          log.message === next.message &&
          log.timestamp === next.timestamp &&
          log.meta === next.meta;

        return isSame ? log : next;
      }),
    }));
  }, []);

  const clearLogs = useCallback((): void => {
    setState({ logs: [], logIdCounter: 0 });
  }, []);

  // Register store methods synchronously during render
  if (!initializedRef.current) {
    printOutputHandler = printOutput;
    updateOutputHandler = updateOutput;
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
    if (pendingUpdates.length > 0) {
      const queuedUpdates = pendingUpdates.splice(0, pendingUpdates.length);
      for (const { id, updates } of queuedUpdates) {
        updateOutput(id, updates);
      }
    }
    initializedRef.current = true;
  }

  // Split logs into static (finalized) and dynamic (recent)
  const { staticLogs, dynamicLogs } = useMemo(() => {
    const totalLogs = state.logs.length;
    if (totalLogs <= DYNAMIC_LOG_COUNT) {
      return { staticLogs: [], dynamicLogs: state.logs };
    }
    return {
      staticLogs: state.logs.slice(0, totalLogs - DYNAMIC_LOG_COUNT),
      dynamicLogs: state.logs.slice(totalLogs - DYNAMIC_LOG_COUNT),
    };
  }, [state.logs]);

  // Compute spacing for dynamic logs
  const dynamicLogsWithSpacing = useMemo(() => {
    const staticLength = staticLogs.length;
    return dynamicLogs.map((log, index) => {
      const globalIndex = staticLength + index;
      const prevLog = globalIndex > 0 ? state.logs[globalIndex - 1] : null;
      return {
        log,
        addSpacing:
          log.type === "user" ||
          (log.type === "info" && prevLog?.type === "user"),
      };
    });
  }, [dynamicLogs, staticLogs.length, state.logs]);

  return (
    <>
      {/* Static logs - Ink renders these once and never touches them again */}
      {staticLogs.length > 0 && (
        <Static items={staticLogs}>
          {(log, index) => {
            const prevLog = index > 0 ? staticLogs[index - 1] : null;
            const addSpacing =
              log.type === "user" ||
              (log.type === "info" && prevLog?.type === "user");
            return (
              <LogEntryItem
                key={log.id}
                log={log}
                addSpacing={addSpacing}
              />
            );
          }}
        </Static>
      )}

      {/* Dynamic logs - These can update */}
      {dynamicLogsWithSpacing.map(({ log, addSpacing }) => (
        <LogEntryItem
          key={log.id}
          log={log}
          addSpacing={addSpacing}
        />
      ))}
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
        {/* Lightweight header - always shown */}
        <AppHeader />

        {/* Status Bar - Isolated state */}
        <StatusIsland />

        {/* Main Chat Area */}
        <Box flexDirection="column" paddingX={1} marginTop={1}>
          {/* Logs - Isolated state with Static optimization */}
          <LogIsland />

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
