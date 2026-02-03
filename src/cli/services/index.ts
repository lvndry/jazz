/**
 * CLI Services - centralized exports for all Effect-TS services.
 */

// Terminal Service
export {
  TerminalCapabilityServiceTag,
  TerminalCapabilityServiceLive,
  getAllSequencesForAction,
  sequenceMatchesAction,
  type TerminalType,
  type TerminalCapabilities,
  type TerminalQuirks,
  type EscapeSequenceProfile,
  type TerminalCapabilityService,
} from "./terminal-service";

// Input Service
export {
  InputServiceTag,
  InputServiceLive,
  createInputService,
  createInputHandler,
  createActionHandler,
  InputPriority,
  InputResults,
  type InputService,
  type InputHandler,
  type InputEvent,
  type InputResult,
} from "./input-service";

// App State Service
export {
  AppStateServiceTag,
  AppStateServiceLive,
  createAppStateService,
  createLogEntry,
  type AppStateService,
  type AppState,
  type LogsSubscriber,
  type PromptSubscriber,
  type StatusSubscriber,
  type StreamSubscriber,
  type Unsubscribe,
} from "./app-state-service";

// Markdown Service
export {
  MarkdownServiceTag,
  MarkdownServiceLive,
  formatMarkdown,
  formatStreamingChunk,
  stripAnsiCodes,
  normalizeBlankLines,
  INITIAL_STREAMING_STATE,
  type MarkdownService,
  type StreamingFormatter,
  type StreamingState,
  type FormattedChunk,
} from "./markdown-service";

// Diff Expansion Service
export {
  DiffExpansionServiceTag,
  DiffExpansionServiceLive,
  registerTruncatedDiff,
  getExpandableDiff,
  clearExpandableDiff,
  hasExpandableDiff,
  type DiffExpansionService,
  type DiffExpansionRequest,
  type TruncatedDiffInfo,
} from "./diff-expansion-service";
