import { Box } from "ink";
import type { Dispatch, SetStateAction } from "react";
import { createContext, useEffect, useState } from "react";
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
  setLogs: Dispatch<SetStateAction<LogEntry[]>>;
  setPrompt: Dispatch<SetStateAction<PromptState | null>>;
  setStatus: Dispatch<SetStateAction<string | null>>;
  setStream: Dispatch<SetStateAction<LiveStreamState | null>>;
}>({
  logs: [],
  prompt: null,
  status: null,
  stream: null,
  setLogs: () => {},
  setPrompt: () => {},
  setStatus: () => {},
  setStream: () => {},
});

// Store logic decoupled from React for Effect integration
export const store = {
  addLog: (_entry: LogEntry): void => {},
  setPrompt: (_prompt: PromptState | null): void => {},
  setStatus: (_status: string | null): void => {},
  setStream: (_stream: LiveStreamState | null): void => {},
};

export function App(): React.ReactElement {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [stream, setStream] = useState<LiveStreamState | null>(null);

  useEffect(() => {
    store.addLog = (entry) => setLogs((prev) => [...prev, entry]);
    store.setPrompt = (prompt) => setPrompt(prompt);
    store.setStatus = (status) => setStatus(status);
    store.setStream = (stream) => setStream(stream);
  }, []);

  return (
    <AppContext.Provider
      value={{ logs, prompt, status, stream, setLogs, setPrompt, setStatus, setStream }}
    >
      <Box
        flexDirection="column"
        padding={1}
      >
        <Header />
        <LogList logs={logs} />
        {stream && <LiveResponse stream={stream} />}
        {prompt && <Prompt prompt={prompt} />}
        <StatusFooter status={status} />
      </Box>
    </AppContext.Provider>
  );
}

export default App;
