import type { TerminalOutput } from "@/core/interfaces/terminal";

export type OutputType = "info" | "success" | "warn" | "error" | "debug" | "log" | "user";

/** Input type for adding output entries - id is auto-generated */
export interface OutputEntry {
  type: OutputType;
  message: TerminalOutput;
  meta?: Record<string, unknown>;
  timestamp: Date;
  /** Optional ID for entries that need to be updated later */
  id?: string;
}

/** Full output entry with auto-generated id */
export interface OutputEntryWithId extends OutputEntry {
  id: string;
}

export type PromptType =
  | "text"
  | "chat"
  | "select"
  | "confirm"
  | "password"
  | "checkbox"
  | "search"
  | "hidden"
  | "questionnaire"
  | "filepicker";

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
