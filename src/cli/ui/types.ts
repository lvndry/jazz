import type { TerminalOutput } from "@/core/interfaces/terminal";

export type LogType = "info" | "success" | "warn" | "error" | "debug" | "log" | "user";

/** Input type for adding logs - id is auto-generated */
export interface LogEntryInput {
  type: LogType;
  message: TerminalOutput;
  meta?: Record<string, unknown>;
  timestamp: Date;
  /** Optional ID for logs that need to be updated later */
  id?: string;
}

/** Full log entry with auto-generated id */
export interface LogEntry extends LogEntryInput {
  id: string;
}

export interface LiveStreamState {
  agentName: string;
  text: string;
  reasoning?: string;
  /** When true, the agent is actively thinking (show thinking indicator in reasoning area) */
  isThinking?: boolean;
}

export type PromptType = "text" | "chat" | "select" | "confirm" | "password" | "checkbox" | "search" | "hidden" | "questionnaire" | "filepicker";

export interface Choice<T = unknown> {
  label: string;
  value: T;
  description?: string;
  disabled?: boolean;
}

export interface PromptOptions<T = unknown> {
  choices?: Choice<T>[];
  defaultSelected?: T | T[];
  /** When true, show command suggestions when input starts with "/" (chat prompt) */
  commandSuggestions?: boolean;
  [key: string]: unknown;
}

export interface PromptState<T = unknown> {
  type: PromptType;
  message: string;
  options?: PromptOptions<T>;
  resolve: (value: T) => void;
  /** Optional reject callback for cancellation (e.g., Escape key) */
  reject?: (reason?: unknown) => void;
}
