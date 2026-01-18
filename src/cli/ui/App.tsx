import { Box } from "ink";
import type { Dispatch, SetStateAction } from "react";
import { createContext, useMemo, useRef, useState } from "react";
import { Header } from "./Header";
import { LiveResponse } from "./LiveResponse";
import { LogEntryItem } from "./LogList";
import { Prompt } from "./Prompt";
import StatusFooter from "./StatusFooter";
import type { LiveStreamState, LogEntry, LogEntryInput, PromptState } from "./types";

export const AppContext = createContext<{
  logs: LogEntry[];
  prompt: PromptState | null;
  status: string | null;
  stream: LiveStreamState | null;
  workingDirectory: string | null;
  setLogs: Dispatch<SetStateAction<LogEntry[]>>;
  setPrompt: Dispatch<SetStateAction<PromptState | null>>;
  setStatus: Dispatch<SetStateAction<string | null>>;
  setStream: Dispatch<SetStateAction<LiveStreamState | null>>;
  setWorkingDirectory: Dispatch<SetStateAction<string | null>>;
}>({
  logs: [],
  prompt: null,
  status: null,
  stream: null,
  workingDirectory: null,
  setLogs: () => { },
  setPrompt: () => { },
  setStatus: () => { },
  setStream: () => { },
  setWorkingDirectory: () => { },
});

/**
 * Store Pattern Architecture
 *
 * This module uses a dual pattern for state management:
 *
 * 1. **External Store (`store` object)**: Provides imperative access to state setters
 *    for Effect-based services that run outside React's lifecycle. Effect code calls
 *    `store.addLog()` directly without needing React context. The store functions are
 *    updated during App's first render via the initializedRef guard.
 *
 * 2. **React Context (`AppContext`)**: Provides reactive state access for components
 *    that need to consume and display logs, prompts, and streaming content within
 *    the React component tree.
 *
 * This separation allows Effect services to push updates into React's render cycle
 * without tight coupling. The store object starts with no-op functions and is
 * populated synchronously during App's first render to prevent race conditions.
 */
export const store = {
  addLog: (_entry: LogEntryInput): string => "",
  updateLog: (_id: string, _entry: Partial<LogEntryInput>): void => { },
  setPrompt: (_prompt: PromptState | null): void => { },
  setStatus: (_status: string | null): void => { },
  setStream: (_stream: LiveStreamState | null): void => { },
  setWorkingDirectory: (_workingDirectory: string | null): void => { },
  clearLogs: (): void => { },
};

export function App(): React.ReactElement {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [stream, setStream] = useState<LiveStreamState | null>(null);
  const [workingDirectory, setWorkingDirectory] = useState<string | null>(null);

  // Use a ref to track initialization and ensure store functions are set synchronously
  // during render, preventing race conditions where store methods are called before
  // initialization completes (e.g., between render() returning and useEffect running)
  const initializedRef = useRef(false);
  // Counter for generating unique log IDs
  const logIdCounterRef = useRef(0);
  // Maximum number of log entries to keep in memory for the UI
  // Older logs are dropped from the state (but persist in log files on disk)
  // Keep this low for performance - Ink re-renders the entire tree
  const MAX_LOG_ENTRIES = 100;

  if (!initializedRef.current) {
    store.addLog = (entry: LogEntryInput): string => {
      const id = entry.id ?? `log-${++logIdCounterRef.current}`;
      setLogs((prev) => {
        // If ID is provided and entry already exists, update it
        if (entry.id && prev.some((log) => log.id === entry.id)) {
          return prev.map((log): LogEntry => {
            if (log.id === entry.id) {
              return { ...log, ...entry, id } as LogEntry;
            }
            return log;
          });
        }
        // Otherwise, add new entry
        const entryWithId: LogEntry = { ...entry, id } as LogEntry;
        // Optimized: when at capacity, shift first element instead of full spread
        if (prev.length >= MAX_LOG_ENTRIES) {
          const next = prev.slice(1);
          next.push(entryWithId);
          return next;
        }
        return [...prev, entryWithId];
      });
      return id;
    };
    store.updateLog = (id: string, updates: Partial<LogEntryInput>): void => {
      setLogs((prev) =>
        prev.map((log): LogEntry => {
          if (log.id === id) {
            return { ...log, ...updates } as LogEntry;
          }
          return log;
        }),
      );
    };
    store.setPrompt = (prompt) => setPrompt(prompt);
    store.setStatus = (status) => setStatus(status);
    store.setStream = (stream) => setStream(stream);
    store.setWorkingDirectory = (workingDirectory) => setWorkingDirectory(workingDirectory);
    store.clearLogs = () => setLogs([]);
    initializedRef.current = true;
  }

  // Memoize context value to prevent unnecessary re-renders of context consumers
  const contextValue = useMemo(
    () => ({
      logs,
      prompt,
      status,
      stream,
      workingDirectory,
      setLogs,
      setPrompt,
      setStatus,
      setStream,
      setWorkingDirectory,
    }),
    [logs, prompt, status, stream, workingDirectory],
  );

  return (
    <AppContext.Provider value={contextValue}>
      <Box
        flexDirection="column"
        padding={1}
      >
        <Header />
        {/* Render logs in order - Header first, then logs */}
        {logs.map((log, index) => (
          <LogEntryItem
            key={log.id}
            log={log}
            addSpacing={log.type === "user" || (log.type === "info" && index > 0 && logs[index - 1]?.type === "user")}
          />
        ))}
        {stream && <LiveResponse stream={stream} />}
        {prompt && <Prompt prompt={prompt} />}
        <StatusFooter
          status={status}
          workingDirectory={workingDirectory}
        />
      </Box>
    </AppContext.Provider>
  );
}

export default App;
