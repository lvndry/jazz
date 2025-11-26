import { Context, Effect } from "effect";

/**
 * Terminal service interface for consistent CLI output and user interaction
 *
 * Provides a unified interface for terminal output with automatic
 * emoji prefixes, color coding, and formatting. Also includes methods
 * for interactive user prompts.
 */
export interface TerminalService {
  /**
   * Display an informational message
   */
  readonly info: (message: string) => Effect.Effect<void, never>;

  /**
   * Display a success message
   */
  readonly success: (message: string) => Effect.Effect<void, never>;

  /**
   * Display an error message
   */
  readonly error: (message: string) => Effect.Effect<void, never>;

  /**
   * Display a warning message
   */
  readonly warn: (message: string) => Effect.Effect<void, never>;

  /**
   * Display a plain message without styling
   */
  readonly log: (message: string) => Effect.Effect<void, never>;

  /**
   * Display a debug message (only shown in debug mode)
   */
  readonly debug: (message: string, meta?: Record<string, unknown>) => Effect.Effect<void, never>;

  /**
   * Display a section heading
   */
  readonly heading: (message: string) => Effect.Effect<void, never>;

  /**
   * Display a formatted list
   */
  readonly list: (items: string[]) => Effect.Effect<void, never>;

  /**
   * Prompt the user for text input
   */
  readonly ask: (
    message: string,
    options?: {
      defaultValue?: string;
      validate?: (input: string) => boolean | string;
    },
  ) => Effect.Effect<string, never>;

  /**
   * Prompt the user for password input (hidden)
   */
  readonly password: (message: string) => Effect.Effect<string, never>;

  /**
   * Prompt the user to select from a list of options
   */
  readonly select: <T = string>(
    message: string,
    options: {
      choices: readonly (string | { name: string; value: T; description?: string })[];
      default?: T;
    },
  ) => Effect.Effect<T, never>;

  /**
   * Prompt the user for confirmation (yes/no)
   */
  readonly confirm: (message: string, defaultValue?: boolean) => Effect.Effect<boolean, never>;

  /**
   * Search and select from a list of options with filtering
   */
  readonly search: <T = string>(
    message: string,
    options: {
      choices: readonly (string | { name: string; value: T; description?: string })[];
    },
  ) => Effect.Effect<T, never>;

  /**
   * Prompt the user to select multiple options (checkbox)
   */
  readonly checkbox: <T = string>(
    message: string,
    options: {
      choices: readonly (string | { name: string; value: T; description?: string })[];
      default?: readonly T[];
    },
  ) => Effect.Effect<readonly T[], never>;
}

export const TerminalServiceTag = Context.GenericTag<TerminalService>("TerminalService");
