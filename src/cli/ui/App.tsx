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

// Store logic decoupled from React for Effect integration
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
        const next = [...prev, entryWithId];
        if (next.length > MAX_LOG_ENTRIES) {
          return next.slice(next.length - MAX_LOG_ENTRIES);
        }
        return next;
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
