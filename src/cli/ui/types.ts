import type { TerminalOutput } from "../../core/interfaces/terminal";

export type LogType = "info" | "success" | "warn" | "error" | "debug" | "log";

export interface LogEntry {
  type: LogType;
  message: TerminalOutput;
  meta?: Record<string, unknown>;
  timestamp: Date;
}

export interface LiveStreamState {
  agentName: string;
  text: string;
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
