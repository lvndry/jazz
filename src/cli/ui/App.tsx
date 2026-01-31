import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
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
  setInterruptHandler: (_handler: (() => void) | null): void => { },
  clearLogs: (): void => { },
};

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

export function App(): React.ReactElement {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [stream, setStream] = useState<LiveStreamState | null>(null);
  const [workingDirectory, setWorkingDirectory] = useState<string | null>(null);
  const [customView, setCustomView] = useState<React.ReactNode | null>(null);
  // Store interrupt handler in a ref since it's imperative and invoked by input event
  // We use a ref so useInput cleanup/setup doesn't re-run or rely on stale closures
  const interruptHandlerRef = useRef<(() => void) | null>(null);

  useInput((input, key) => {
    // Check for Ctrl+I (which comes through as tab in terminals - ASCII 9)
    // Also check for tab character directly in case key.tab isn't set
    const isTabOrCtrlI = key.tab || input === "\t" || input.charCodeAt(0) === 9;
    if (isTabOrCtrlI) {
      if (interruptHandlerRef.current) {
         interruptHandlerRef.current();
      }
    }
  });

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
          if (log.id !== id) {
            return log;
          }

          const next = { ...log, ...updates } as LogEntry;
          const isSame =
            log.type === next.type &&
            log.message === next.message &&
            log.timestamp === next.timestamp &&
            log.meta === next.meta;

          return isSame ? log : next;
        }),
      );
    };
    store.setPrompt = (prompt) => setPrompt(prompt);
    store.setStatus = (status) => setStatus(status);
    store.setStream = (nextStream) =>
      setStream((prev) => (isSameStream(prev, nextStream) ? prev : nextStream));
    store.setWorkingDirectory = (workingDirectory) => setWorkingDirectory(workingDirectory);
    store.setCustomView = (view) => setCustomView(view);
    store.setInterruptHandler = (handler) => {
      interruptHandlerRef.current = handler;
    };
    store.clearLogs = () => setLogs([]);
    initializedRef.current = true;
  }

  const logsWithSpacing = useMemo(
    () =>
      logs.map((log, index) => ({
        log,
        addSpacing:
          log.type === "user" ||
          (log.type === "info" && index > 0 && logs[index - 1]?.type === "user"),
      })),
    [logs],
  );

  const logItems = useMemo(
    () =>
      logsWithSpacing.map(({ log, addSpacing }) => (
        <LogEntryItem
          key={log.id}
          log={log}
          addSpacing={addSpacing}
        />
      )),
    [logsWithSpacing],
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
               title={status ? (
                 <Text>
                   <Text color="yellow"><Spinner type="dots" /> </Text>
                   {status}
                 </Text>
               ) : undefined}
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
              {logItems}
              {!!(status && !stream) && (
                 <Box paddingY={1}>
                   <Text color="yellow"><Spinner type="dots" /> {status}</Text>
                 </Box>
              )}
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
