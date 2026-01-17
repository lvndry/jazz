import { Box } from "ink";
import type { Dispatch, SetStateAction } from "react";
import { createContext, useRef, useState } from "react";
import { Header } from "./Header";
import { LiveResponse } from "./LiveResponse";
import { LogList } from "./LogList";
import { Prompt } from "./Prompt";
import StatusFooter from "./StatusFooter";
import type { LiveStreamState, LogEntry, PromptState } from "./types";

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
  addLog: (_entry: LogEntry): void => { },
  setPrompt: (_prompt: PromptState | null): void => { },
  setStatus: (_status: string | null): void => { },
  setStream: (_stream: LiveStreamState | null): void => { },
  setWorkingDirectory: (_workingDirectory: string | null): void => { },
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
  // Maximum number of log entries to keep in memory for the UI
  // Older logs are dropped from the state (but persist in log files on disk)
  const MAX_LOG_ENTRIES = 1000;

  if (!initializedRef.current) {
    store.addLog = (entry) =>
      setLogs((prev) => {
        const next = [...prev, entry];
        if (next.length > MAX_LOG_ENTRIES) {
          return next.slice(next.length - MAX_LOG_ENTRIES);
        }
        return next;
      });
    store.setPrompt = (prompt) => setPrompt(prompt);
    store.setStatus = (status) => setStatus(status);
    store.setStream = (stream) => setStream(stream);
    store.setWorkingDirectory = (workingDirectory) => setWorkingDirectory(workingDirectory);
    initializedRef.current = true;
  }

  return (
    <AppContext.Provider
      value={{
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
      }}
    >
      <Box
        flexDirection="column"
        padding={1}
      >
        <Header />
        <LogList logs={logs} />
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
