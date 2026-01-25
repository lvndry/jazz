import { Box, Text } from "ink";
import type { Dispatch, SetStateAction } from "react";
import { createContext, useMemo, useRef, useState } from "react";
import ErrorBoundary from "./ErrorBoundary";
import { Layout } from "./Layout";
import { LiveResponse } from "./LiveResponse";
import { LogEntryItem } from "./LogList";
import { Prompt } from "./Prompt";
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

export const store = {
  printOutput: (_entry: LogEntryInput): string => "",
  updateOutput: (_id: string, _entry: Partial<LogEntryInput>): void => { },
  setPrompt: (_prompt: PromptState | null): void => { },
  setStatus: (_status: string | null): void => { },
  setStream: (_stream: LiveStreamState | null): void => { },
  setWorkingDirectory: (_workingDirectory: string | null): void => { },
  setCustomView: (_view: React.ReactNode | null): void => { },
  clearLogs: (): void => { },
};

export function App(): React.ReactElement {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [stream, setStream] = useState<LiveStreamState | null>(null);
  const [workingDirectory, setWorkingDirectory] = useState<string | null>(null);
  const [customView, setCustomView] = useState<React.ReactNode | null>(null);

  const initializedRef = useRef(false);
  const logIdCounterRef = useRef(0);
  const MAX_LOG_ENTRIES = 100;

  if (!initializedRef.current) {
    store.printOutput = (entry: LogEntryInput): string => {
      const id = entry.id ?? `log-${++logIdCounterRef.current}`;
      setLogs((prev) => {
        if (entry.id && prev.some((log) => log.id === entry.id)) {
          return prev.map((log): LogEntry => {
            if (log.id === entry.id) {
              return { ...log, ...entry, id } as LogEntry;
            }
            return log;
          });
        }
        const entryWithId: LogEntry = { ...entry, id } as LogEntry;
        if (prev.length >= MAX_LOG_ENTRIES) {
          const next = prev.slice(1);
          next.push(entryWithId);
          return next;
        }
        return [...prev, entryWithId];
      });
      return id;
    };

    store.updateOutput = (id: string, updates: Partial<LogEntryInput>): void => {
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
    store.setCustomView = (view) => setCustomView(view);
    store.clearLogs = () => setLogs([]);
    initializedRef.current = true;
  }

  const logsWithSpacing = useMemo(
    () =>
      logs.map((log, index) => ({
        log,
        addSpacing: log.type === "user" || (log.type === "info" && index > 0 && logs[index - 1]?.type === "user"),
      })),
    [logs],
  );

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
    <ErrorBoundary>
      <AppContext.Provider value={contextValue}>
        {customView ? (
          customView
        ) : (
          <Box flexDirection="column">
            {/* Top Dashboard: uses Layout for the framed look */}
            <Layout
               title={status ? `• ${status}` : undefined}
               sidebar={
                 <Box flexDirection="column">
                   <Box marginBottom={1}>
                     <Text bold color="cyan">💡 Tip</Text>
                   </Box>
                   <Text dimColor>Type '/help' for commands</Text>
                 </Box>
               }
            >
               <Box flexDirection="column">
                 {stream ? (
                   <>
                     <Text bold color="cyan">🤖 Active Session</Text>
                     <Text bold>{stream.agentName}</Text>
                   </>
                 ) : (
                    <>
                      <Text bold color="cyan">👋 Welcome</Text>
                      <Text>Ready to assist.</Text>
                    </>
                 )}
               </Box>
            </Layout>

            {/* Main Chat Area - Unboxed for easy text selection/copying */}
            <Box
              flexDirection="column"
              paddingX={1}
              marginTop={1}
            >
              {logsWithSpacing.map(({ log, addSpacing }) => (
                <LogEntryItem
                  key={log.id}
                  log={log}
                  addSpacing={addSpacing}
                />
              ))}
              {stream && <LiveResponse stream={stream} />}
              {prompt && <Prompt prompt={prompt} />}
            </Box>
          </Box>
        )}
      </AppContext.Provider>
    </ErrorBoundary>
  );
}

export default App;
