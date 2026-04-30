import { Box, Static, Text, useInput } from "ink";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { isActivityEqual, type ActivityState } from "./activity-state";
import { ActivityView } from "./ActivityView";
import { useTerminalOutputAdapter } from "./adapters/terminal-output-adapter";
import type { PendingStream } from "./adapters/terminal-output-adapter";
import { PreWrappedText } from "./components/PreWrappedText";
import { EphemeralPanelIsland } from "./EphemeralPanelIsland";
import ErrorBoundary from "./ErrorBoundary";
import { formatMarkdown, wrapToWidth } from "../presentation/markdown-formatter";
import { useInputHandler } from "./hooks/use-input-service";
import { OutputEntryView } from "./OutputEntryView";
import { Prompt } from "./Prompt";
import StatusFooter from "./StatusFooter";
import { store, type RunStats } from "./store";
import { PADDING, PADDING_BUDGET, THEME } from "./theme";
import type { OutputEntryWithId, PromptState } from "./types";
import { dimReasoningMarkdownOutput } from "../presentation/format-utils";
import { InputPriority, InputResults } from "../services/input-service";
import { getTerminalWidth } from "../utils/string-utils";

// ============================================================================
// Activity Island - Unified state for status + streaming response
// ============================================================================

function ActivityIslandComponent(): React.ReactElement | null {
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
    return () => {
      store.registerActivitySetter(() => {});
    };
  }, []);

  if (activity.phase === "idle" || activity.phase === "complete") return null;

  return <ActivityView activity={activity} />;
}

const ActivityIsland = React.memo(ActivityIslandComponent);

// ============================================================================
// Prompt Island - Isolated state for user input prompt
// ============================================================================

function PromptIslandComponent(): React.ReactElement | null {
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

  return (
    <Prompt
      prompt={prompt}
      workingDirectory={workingDirectory}
    />
  );
}

const PromptIsland = React.memo(PromptIslandComponent);

// ============================================================================
// Status Footer Island — model · tokens · cost · cwd
// ============================================================================

function StatusFooterIslandComponent(): React.ReactElement | null {
  // RunStats is the footer's primary content — model · tokens · cost.
  // The working directory is rendered by the prompt island already, so
  // we don't duplicate it here (avoids conflicting with the prompt's
  // single-slot wd setter).
  const [runStats, setRunStats] = React.useState<RunStats>({});
  const initializedRef = useRef(false);

  if (!initializedRef.current) {
    store.registerRunStatsSetter(setRunStats);
    setRunStats(store.getRunStatsSnapshot());
    initializedRef.current = true;
  }

  useEffect(() => {
    return () => {
      store.registerRunStatsSetter(() => {});
    };
  }, []);

  return (
    <StatusFooter
      status={null}
      workingDirectory={null}
      runStats={runStats}
    />
  );
}

const StatusFooterIsland = React.memo(StatusFooterIslandComponent);

// ============================================================================
// Output Island - Isolated state for output entries
//
// Uses TerminalOutputAdapter for two-tier Static/live rendering.
// ============================================================================

function renderPendingStream(pending: PendingStream): string {
  // The renderer's display config is wired up via store; for this island we
  // default to formatMarkdown. If the user's display config is `hybrid`, the
  // renderer will set its own pending text via store.appendStream — the buffer
  // contains raw markdown either way. We always render with `formatMarkdown`
  // here; the activity-island's display config doesn't change formatting
  // semantics for the pending tail.
  //
  // Pre-wrap to terminal width: under heavy live-area re-rendering Yoga can
  // miscalculate the available width and degenerate into character-by-character
  // wrapping. Hard-wrapping upstream + rendering with PreWrappedText
  // (wrap="truncate") sidesteps that. Same pattern as formatReasoningText
  // in ink-presentation-service.ts.
  const formatted = formatMarkdown(pending.rawTail);
  const dimmed = pending.kind === "reasoning" ? dimReasoningMarkdownOutput(formatted) : formatted;
  const width = Math.max(20, getTerminalWidth() - PADDING_BUDGET - PADDING.content);
  return wrapToWidth(dimmed, width);
}

function OutputIslandComponent(): React.ReactElement {
  const { state, appendStatic, appendStream, finalizeStream, clear } = useTerminalOutputAdapter();
  const initializedRef = useRef(false);

  const printOutput = useCallback(
    (entryOrBatch: Parameters<typeof appendStatic>[0]) => appendStatic(entryOrBatch),
    [appendStatic],
  );
  const clearOutputs = useCallback(() => clear(), [clear]);

  if (!initializedRef.current) {
    store.registerPrintOutput(printOutput);
    store.registerClearOutputs(clearOutputs);
    store.registerStreamingHandler({ appendStream, finalizeStream });
    if (store.hasPendingClear()) {
      clearOutputs();
      store.consumePendingClear();
    }
    const queued = store.drainPendingOutputQueue();
    for (const entry of queued) printOutput(entry);
    initializedRef.current = true;
  }

  useEffect(() => {
    return () => {
      store.registerPrintOutput(() => "");
      store.registerClearOutputs(() => {});
      store.registerStreamingHandler(null);
    };
  }, []);

  const pending = state.pending;

  return (
    <Box flexDirection="column">
      <Static
        key={state.staticGeneration}
        items={state.staticEntries}
      >
        {(entry: OutputEntryWithId, index: number) => {
          const prevEntry = index > 0 ? state.staticEntries[index - 1] : null;
          const addSpacing =
            entry.type === "user" || (entry.type === "info" && prevEntry?.type === "user");
          return (
            <OutputEntryView
              key={entry.id}
              entry={entry}
              addSpacing={addSpacing}
            />
          );
        }}
      </Static>

      {pending !== null && (
        <Box paddingLeft={PADDING.content}>
          <PreWrappedText>{renderPendingStream(pending)}</PreWrappedText>
        </Box>
      )}
    </Box>
  );
}

const OutputIsland = React.memo(OutputIslandComponent);

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
      store.registerInterruptHandler(null);
    };
  }, []);

  // Handle Ctrl+C — bridge from Ink raw mode to process SIGINT
  // With exitOnCtrlC: false, Ink forwards Ctrl+C to useInput instead of
  // swallowing it. We raise a real SIGINT so the handler in app-layer.ts fires.
  useInput((input, key) => {
    if (input === "c" && key.ctrl) {
      process.kill(process.pid, "SIGINT");
    }
  });

  // Handle interrupt (double-tap Escape)
  const lastEscapeRef = useRef<number>(0);
  const escapeHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Use a ref for synchronous read in the input handler (React state updates are async
  // and would cause the second ESC press to always see showEscapeHint === false).
  const escapeHintActiveRef = useRef(false);
  const [showEscapeHint, setShowEscapeHint] = useState(false);
  const DOUBLE_ESCAPE_WINDOW_MS = 1000;

  useInput((input, key) => {
    const isEscape = key.escape || input === "\x1b";
    if (!isEscape || !interruptHandlerRef.current) {
      return;
    }

    const now = Date.now();
    const elapsed = now - lastEscapeRef.current;
    lastEscapeRef.current = now;

    if (elapsed <= DOUBLE_ESCAPE_WINDOW_MS && escapeHintActiveRef.current) {
      // Second press — interrupt generation
      lastEscapeRef.current = 0;
      escapeHintActiveRef.current = false;
      setShowEscapeHint(false);
      if (escapeHintTimerRef.current) {
        clearTimeout(escapeHintTimerRef.current);
        escapeHintTimerRef.current = null;
      }
      // User-initiated abort — drop any open ephemeral panels (subagents,
      // reasoning) so they don't get stuck after the run is interrupted.
      store.collapseAllEphemeral();
      interruptHandlerRef.current();
    } else {
      // First press — show hint, auto-dismiss after timeout
      escapeHintActiveRef.current = true;
      setShowEscapeHint(true);
      if (escapeHintTimerRef.current) {
        clearTimeout(escapeHintTimerRef.current);
      }
      escapeHintTimerRef.current = setTimeout(() => {
        escapeHintActiveRef.current = false;
        setShowEscapeHint(false);
        escapeHintTimerRef.current = null;
      }, DOUBLE_ESCAPE_WINDOW_MS);
    }
  });

  // Ctrl-R — expand most recently collapsed reasoning into scrollback.
  // Skipped while a reasoning panel is currently open (the live one IS the
  // expanded view). No-op if no expandable reasoning is available.
  useInput((input, key) => {
    if (key.ctrl && (input === "r" || input === "\x12")) {
      const hasOpenReasoning = store
        .getEphemeralRegionsSnapshot()
        .some((r) => r.kind === "reasoning");
      if (hasOpenReasoning) return;
      store.expandLastReasoning();
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

      const payload = store.getExpandableDiff();
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
      store.clearExpandableDiff();
      return InputResults.consumed();
    },
    deps: [],
  });

  return (
    <ErrorBoundary>
      {customView}
      <Box
        flexDirection="column"
        display={customView ? "none" : "flex"}
      >
        <Box
          flexDirection="column"
          paddingX={PADDING.page}
          marginTop={1}
        >
          <ErrorBoundary fallback={<Text color="red">Output area error. Restart may help.</Text>}>
            <OutputIsland />
          </ErrorBoundary>

          <ErrorBoundary fallback={<Text color="red">Activity area error. Restart may help.</Text>}>
            <ActivityIsland />
          </ErrorBoundary>

          <ErrorBoundary
            fallback={<Text color="red">Live panel area error. Restart may help.</Text>}
          >
            <EphemeralPanelIsland />
          </ErrorBoundary>

          {showEscapeHint && (
            <Box
              marginTop={1}
              paddingX={PADDING.content}
            >
              <Text color={THEME.error}>Press Esc again to interrupt generation</Text>
            </Box>
          )}

          <Box marginTop={1}>
            <ErrorBoundary fallback={<Text color="red">Prompt area error. Restart may help.</Text>}>
              <PromptIsland />
            </ErrorBoundary>
          </Box>

          <ErrorBoundary fallback={<Text color="red">Status footer error. Restart may help.</Text>}>
            <StatusFooterIsland />
          </ErrorBoundary>
        </Box>
      </Box>
    </ErrorBoundary>
  );
}

export default App;
