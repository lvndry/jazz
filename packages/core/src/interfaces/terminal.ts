/**
 * Renderer-independent terminal reports and interactive prompt ports. Commands
 * publish text or typed report rows; adapters own layout. Input continuations
 * remain effects on the port and are never persisted as presentation content.
 */
import { Context, Effect } from "effect";

/** How a report value reads: plain text, or one of the semantic status tones. */
export type ReportTone = "text" | "muted" | "accent" | "success" | "warning" | "error";

/**
 * A mark in front of a listed item: the current one, an active one, an idle one,
 * one that needs attention, or one turned off.
 */
export type ReportMarker = "current" | "active" | "inactive" | "attention" | "disabled";

/**
 * One row of a command report.
 *
 * - `field`: a key and its value, e.g. `model  openai/gpt-5.6`. Numeric values in one run right-align.
 * - `item`: a listed thing with an optional marker and a muted detail column.
 * - `meter`: a used-of-total bar with its caption.
 * - `text`: a line of prose.
 * - `group`: the heading of the rows that follow, with an optional count.
 * - `gap`: one blank row between groups.
 */
export type ReportRow =
  | {
      readonly kind: "field";
      readonly key: string;
      readonly value: string;
      readonly tone?: ReportTone;
      readonly detail?: string;
    }
  | {
      readonly kind: "item";
      readonly name: string;
      readonly detail?: string;
      readonly marker?: ReportMarker;
      readonly tone?: ReportTone;
    }
  | {
      readonly kind: "meter";
      readonly used: number;
      readonly total: number;
      readonly caption: string;
    }
  | { readonly kind: "text"; readonly text: string; readonly tone?: ReportTone }
  | { readonly kind: "group"; readonly label: string; readonly count?: string }
  | { readonly kind: "gap" };

/**
 * What a slash command says back, as data rather than pre-styled text: a short
 * label naming the command, its rows, and at most one line of explanation.
 * Each terminal lays it out in jazz's own voice, distinct from the agent's.
 */
export interface TerminalReport {
  readonly _tag: "report";
  readonly label: string;
  readonly rows: readonly ReportRow[];
  readonly note?: string;
}

/** Build a command report for `terminal.log`. */
export function report(label: string, rows: readonly ReportRow[], note?: string): TerminalReport {
  return { _tag: "report", label, rows, ...(note === undefined ? {} : { note }) };
}

export function isTerminalReport(value: unknown): value is TerminalReport {
  return (
    typeof value === "object" && value !== null && (value as { _tag?: unknown })._tag === "report"
  );
}

/**
 * Terminal output that can be written to the UI.
 *
 * - `string`: standard terminal text
 * - `TerminalReport`: a command's structured answer, laid out by each terminal
 */
export type TerminalOutput = string | TerminalReport;

/** Stable presentation categories shared by live and persisted terminal output. */
export const TERMINAL_OUTPUT_KINDS = [
  "info",
  "success",
  "warn",
  "error",
  "debug",
  "log",
  "user",
  "streamContent",
] as const;

export type TerminalOutputKind = (typeof TERMINAL_OUTPUT_KINDS)[number];

export function isTerminalOutputKind(value: unknown): value is TerminalOutputKind {
  return typeof value === "string" && TERMINAL_OUTPUT_KINDS.includes(value as TerminalOutputKind);
}

/** Where a prompt sits in a multi-step flow: every step's label, and which one this is. */
export interface PromptStep {
  readonly labels: readonly string[];
  readonly index: number;
}

/** How a choice's tag reads: its readiness, a consequence, or plain information. */
export type PromptTagTone = "success" | "warning" | "accent" | "muted";

/** One styled run of text inside a choice preview. `fg` is a theme-independent hex color. */
export interface ChoicePreviewSpan {
  readonly text: string;
  readonly fg?: string;
  readonly bold?: boolean;
}

/** One line of a choice preview, as a sequence of styled runs. */
export type ChoicePreviewLine = readonly ChoicePreviewSpan[];

/** A choice in a list prompt. `tag` is a short state shown flush right, such as "key saved". */
export interface PromptChoice<T> {
  readonly name: string;
  readonly value: T;
  readonly description?: string;
  readonly disabled?: boolean;
  readonly tag?: string;
  readonly tagTone?: PromptTagTone;
  /** Rendered live beside (fullscreen) or beneath (Ink) the choice while it is highlighted. */
  readonly preview?: readonly ChoicePreviewLine[];
}

/**
 * Terminal service interface for consistent CLI output and user interaction
 *
 * Provides a unified interface for terminal output with automatic
 * emoji prefixes, color coding, and formatting. Also includes methods
 * for interactive user prompts.
 */
export interface TerminalService {
  /**
   * Whether this terminal can actually prompt the user for input.
   *
   * False for plain/non-TTY terminals. There, `ask` and `password` read the
   * next line of stdin (resolving `undefined` once stdin ends) and every menu
   * or confirmation resolves `undefined` without asking. Callers that need a
   * real choice from a person must check this first.
   */
  readonly isInteractive: boolean;

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
  readonly log: (message: TerminalOutput) => Effect.Effect<string | undefined, never>;

  /**
   * Echo a user-submitted message to scrollback as `You: <message>`.
   *
   * The interactive `ask("You:", ...)` flow already does this on resolve;
   * other paths that bypass `ask` (e.g. queue drain in chat-service) call
   * this directly so the visual output stays consistent.
   */
  readonly user: (message: string) => Effect.Effect<void, never>;

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
   * Clear the terminal screen
   */
  readonly clear: () => Effect.Effect<void, never>;

  /**
   * Prompt the user for text input.
   * Returns undefined if cancelled (e.g., Escape key) when cancellable or secret is true,
   * and on a non-interactive terminal once stdin has no more lines.
   */
  readonly ask: (
    message: string,
    options?: {
      defaultValue?: string;
      validate?: (input: string) => boolean | string;
      /** When true, show command suggestions when input starts with "/" (e.g. chat prompt) */
      commandSuggestions?: boolean;
      /** When true, allow ESC to cancel and return undefined. Default: false for backwards compatibility. */
      cancellable?: boolean;
      /** When true, use a minimal inline input instead of the full chat-style box. */
      simple?: boolean;
      /** When true, hide the prompt UI but still wait for Enter key. Useful for "Press Enter to continue" scenarios. */
      hidden?: boolean;
      /** With `hidden`, resolve with the pressed key when it is one of these, or "" on Enter/Esc, drawing no prompt; the message is shown as footer hints, split on ", ". */
      keys?: readonly string[];
      /** Optional placeholder text to show when input is empty. */
      placeholder?: string;
      /** When true, mask the live input and the echoed value (e.g. for API keys). Secret prompts are always Esc-cancellable. */
      secret?: boolean;
      /** Where this prompt sits in a multi-step flow. */
      step?: PromptStep;
    },
  ) => Effect.Effect<string | undefined, never>;

  /**
   * Prompt the user for password input (hidden).
   * Returns undefined on a non-interactive terminal once stdin has no more lines.
   */
  readonly password: (
    message: string,
    options?: {
      validate?: (input: string) => boolean | string;
    },
  ) => Effect.Effect<string | undefined, never>;

  /**
   * Prompt the user to select from a list of options.
   * Returns undefined if cancelled (e.g., Escape key).
   *
   * With `customAnswer`, text typed into the filter is also offered as an answer; submitting it
   * returns `customAnswer(text)`. Leave it unset when only the listed values are valid.
   */
  readonly select: <T = string>(
    message: string,
    options: {
      choices: readonly (string | PromptChoice<T>)[];
      default?: T;
      customAnswer?: (text: string) => T;
      /** Where this prompt sits in a multi-step flow. */
      step?: PromptStep;
    },
  ) => Effect.Effect<T | undefined, never>;

  /**
   * Prompt the user for confirmation (yes/no).
   * Returns undefined when the user cancels (e.g. presses Escape).
   */
  readonly confirm: (
    message: string,
    defaultValue?: boolean,
  ) => Effect.Effect<boolean | undefined, never>;

  /**
   * Search and select from a list of options with filtering.
   * Returns undefined if cancelled (e.g., Escape key).
   */
  readonly search: <T = string>(
    message: string,
    options: {
      choices: readonly (string | PromptChoice<T>)[];
      /** Optional placeholder text to show when search query is empty. */
      placeholder?: string;
      /** Where this prompt sits in a multi-step flow. */
      step?: PromptStep;
    },
  ) => Effect.Effect<T | undefined, never>;

  /**
   * Prompt the user to select multiple options (checkbox).
   * Returns undefined when the user cancels (e.g. presses Escape).
   */
  readonly checkbox: <T = string>(
    message: string,
    options: {
      choices: readonly (string | PromptChoice<T>)[];
      default?: readonly T[];
      /** Where this prompt sits in a multi-step flow. */
      step?: PromptStep;
    },
  ) => Effect.Effect<readonly T[] | undefined, never>;

  /**
   * Set the terminal tab/window title
   * Uses ANSI escape sequences (OSC) to update the title
   * Supported by most modern terminals including Warp, iTerm2, WezTerm, etc.
   */
  readonly setTitle: (title: string) => Effect.Effect<void, never>;

  /**
   * Cleanup method for terminal service (e.g., unmount Ink UI)
   * Optional - not all implementations need this
   */
  readonly cleanup?: () => void;
}

export const TerminalServiceTag = Context.GenericTag<TerminalService>("TerminalService");
