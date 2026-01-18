import type { TerminalOutput } from "../../core/interfaces/terminal";

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
}

export type PromptType = "text" | "select" | "confirm" | "password" | "checkbox";

export interface Choice<T = unknown> {
  label: string;
  value: T;
  description?: string;
}

export interface PromptOptions<T = unknown> {
  choices?: Choice<T>[];
  defaultSelected?: T | T[];
  [key: string]: unknown;
}

export interface PromptState<T = unknown> {
  type: PromptType;
  message: string;
  options?: PromptOptions<T>;
  resolve: (value: T) => void;
}
