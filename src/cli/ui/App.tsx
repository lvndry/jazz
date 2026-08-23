import { Box, Static, Text, useInput } from "ink";
import React, { useEffect, useRef, useState } from "react";
import { ActivityView } from "./ActivityView";
import type { PendingStream } from "./adapters/terminal-output-adapter";
import { PreWrappedText } from "./components/PreWrappedText";
import { useTerminalDimensions } from "./contexts/TerminalDimensionsContext";
import { EphemeralPanelIsland } from "./EphemeralPanelIsland";
import ErrorBoundary from "./ErrorBoundary";
import { formatMarkdown, wrapToWidth } from "../presentation/markdown-formatter";
import { useInputHandler } from "./hooks/use-input-service";
import { OutputEntryView } from "./OutputEntryView";
import { Prompt } from "./Prompt";
import { QueueInput } from "./QueueInput";
import { RAIL_WIDTH, railStreamLines } from "./rail";
import StatusFooter from "./StatusFooter";
import { store, useOutputSlice, usePromptSlice, useSessionSlice, type ActiveMenu } from "./store";
import { PADDING, PADDING_BUDGET, THEME } from "./theme";
import type { OutputEntryWithId } from "./types";
import { WizardHome } from "./WizardHome";
import { dimReasoningMarkdownOutput } from "../presentation/format-utils";
import { InputPriority, InputResults } from "../services/input-service";

// ============================================================================
// Activity Island - Unified state for status + streaming response
// ============================================================================

function ActivityIslandComponent(): React.ReactElement | null {
  const { activity } = useSessionSlice();

  if (activity.phase === "idle" || activity.phase === "complete") return null;

  return <ActivityView activity={activity} />;
}

const ActivityIsland = React.memo(ActivityIslandComponent);

// ============================================================================
// Prompt Island - Isolated state for user input prompt
// ============================================================================

function PromptIslandComponent(): React.ReactElement | null {
  const { prompt, messageQueue } = usePromptSlice();
  const { workingDirectory, chatBusy } = useSessionSlice();

  if (prompt) {
    return (
      <Prompt
        prompt={prompt}
        workingDirectory={workingDirectory}
      />
    );
  }

  if (chatBusy) {
    return (
      <QueueInput
        queue={messageQueue}
        workingDirectory={workingDirectory}
      />
    );
  }

  return null;
}

const PromptIsland = React.memo(PromptIslandComponent);

// ============================================================================
// Status Footer Island — model · tokens · cost · cwd
// ============================================================================

function StatusFooterIslandComponent(): React.ReactElement | null {
  const { runStats, isYolo } = useSessionSlice();

  return (
    <StatusFooter
      status={null}
      workingDirectory={null}
      runStats={runStats}
      modeIsYolo={isYolo}
    />
  );
}

const StatusFooterIsland = React.memo(StatusFooterIslandComponent);

// ============================================================================
// Output Island - Isolated state for output entries
//
// Uses TerminalOutputAdapter for two-tier Static/live rendering.
// ============================================================================

function renderPendingStream(pending: PendingStream, cols: number): string {
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
  const width = Math.max(20, cols - PADDING_BUDGET - PADDING.content - RAIL_WIDTH);
  // Same speaker rail as settled slices so the live tail is seamless.
  return railStreamLines(wrapToWidth(dimmed, width), pending.kind);
}

function OutputIslandComponent(): React.ReactElement {
  const output = useOutputSlice();
  const { cols } = useTerminalDimensions();
  const pending = output.pending;

  return (
    <Box flexDirection="column">
      <Static
        key={output.staticGeneration}
        items={output.entries as OutputEntryWithId[]}
      >
        {(entry: OutputEntryWithId, index: number) => {
          const prevEntry = index > 0 ? output.entries[index - 1] : null;
          const isReasoning =
            entry.type === "streamContent" && entry.meta?.["kind"] === "reasoning";
          const prevIsReasoning =
            prevEntry?.type === "streamContent" && prevEntry.meta?.["kind"] === "reasoning";
          const addSpacing =
            entry.type === "user" ||
            (entry.type === "info" && prevEntry?.type === "user") ||
            (isReasoning && prevIsReasoning);
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
          <PreWrappedText>{renderPendingStream(pending, cols)}</PreWrappedText>
        </Box>
      )}
    </Box>
  );
}

const OutputIsland = React.memo(OutputIslandComponent);

// ============================================================================
// Main App Component
// ============================================================================

function ActiveMenuView({ menu }: { readonly menu: ActiveMenu }): React.ReactElement {
  const options =
    menu.kind === "agents"
      ? menu.agents.map((agent) => ({
          label: `${agent.name} (${agent.model})`,
          value: agent.id,
        }))
      : menu.options;
  const title = menu.title;
  const browse = menu.kind === "agents" && menu.browse === true;

  return (
    <WizardHome
      options={options}
      {...(title === undefined ? {} : { title })}
      onSelect={(value) => {
        if (browse) {
          store.completePrompt({ kind: "exit" });
          return;
        }
        store.completePrompt({ kind: "select", value });
      }}
      onExit={() => store.completePrompt({ kind: "exit" })}
    />
  );
}

export function App(): React.ReactElement {
  const { activeMenu: menu, interruptHandler, modeToast } = useSessionSlice();
  const interruptHandlerRef = useRef(interruptHandler);
  interruptHandlerRef.current = interruptHandler;
  const modeToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (modeToast === null) return;
    if (modeToastTimerRef.current) {
      clearTimeout(modeToastTimerRef.current);
    }
    modeToastTimerRef.current = setTimeout(() => {
      store.clearModeToast();
      modeToastTimerRef.current = null;
    }, 2000);
    return () => {
      if (modeToastTimerRef.current) {
        clearTimeout(modeToastTimerRef.current);
        modeToastTimerRef.current = null;
      }
    };
  }, [modeToast]);

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
      // reasoning) and any queued chat message so nothing gets stuck after
      // the run is interrupted. Print immediate feedback: the loop's own
      // "generation stopped" line can lag behind a mid-flight tool.
      store.printOutput({
        type: "warn",
        message: "Interrupting…",
        timestamp: new Date(),
      });
      store.collapseAllEphemeral();
      store.clearQueue();
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
          message: "No truncated output available to expand.",
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

  // Handle Shift+Tab mode toggle (safe <-> yolo)
  useInputHandler({
    id: "mode-toggle-handler",
    priority: InputPriority.GLOBAL_SHORTCUT,
    onInput: (action) => {
      if (action.type !== "shift-tab") {
        return InputResults.ignored();
      }

      store.toggleMode();
      return InputResults.consumed();
    },
    deps: [],
  });

  return (
    <ErrorBoundary>
      {menu !== null && <ActiveMenuView menu={menu} />}
      <Box
        flexDirection="column"
        display={menu !== null ? "none" : "flex"}
      >
        <Box
          flexDirection="column"
          paddingX={PADDING.page}
          marginTop={1}
        >
          <ErrorBoundary
            fallback={<Text color={THEME.error}>Output area error. Restart may help.</Text>}
          >
            <OutputIsland />
          </ErrorBoundary>

          <ErrorBoundary
            fallback={<Text color={THEME.error}>Activity area error. Restart may help.</Text>}
          >
            <ActivityIsland />
          </ErrorBoundary>

          <ErrorBoundary
            fallback={<Text color={THEME.error}>Live panel area error. Restart may help.</Text>}
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

          {modeToast && (
            <Box
              marginTop={1}
              paddingX={PADDING.content}
            >
              <Text color={THEME.primary}>{modeToast}</Text>
            </Box>
          )}

          <Box marginTop={1}>
            <ErrorBoundary
              fallback={<Text color={THEME.error}>Prompt area error. Restart may help.</Text>}
            >
              <PromptIsland />
            </ErrorBoundary>
          </Box>

          <ErrorBoundary
            fallback={<Text color={THEME.error}>Status footer error. Restart may help.</Text>}
          >
            <StatusFooterIsland />
          </ErrorBoundary>
        </Box>
      </Box>
    </ErrorBoundary>
  );
}

export default App;
