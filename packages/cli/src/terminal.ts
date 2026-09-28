/**
 * TerminalService implementation backed by Ink — mounts the React/Ink app and
 * routes terminal output/input through it.
 */

import {
  isTerminalReport,
  TerminalServiceTag,
  type PromptChoice,
  type PromptStep,
  type TerminalOutput,
  type TerminalService,
} from "@jazz/core/interfaces/terminal";
import chalk from "chalk";
import { Effect, Layer } from "effect";
import { render } from "ink";
import React from "react";
import { wrapToWidth, getTerminalWidth } from "@/cli/presentation/markdown-formatter";
import { createLineSource, type LineSource } from "@/cli/stdin-lines";
import App from "@/cli/ui/App";
import { InputProvider } from "@/cli/ui/contexts/InputContext";
import { TerminalDimensionsProvider } from "@/cli/ui/contexts/TerminalDimensionsContext";
import { mountFullscreenApp, type FullscreenHandle } from "@/cli/ui/fullscreen/attach";
import { getGlyphs } from "@/cli/ui/glyphs";
import { setActiveKeymap } from "@/cli/ui/keymaps";
import { maskSecret } from "@/cli/ui/mask-secret";
import { reportAnsiText } from "@/cli/ui/report-ansi";
import { reportPlainText } from "@/cli/ui/report-layout";
import { store } from "@/cli/ui/store";
import { CHALK_THEME, PADDING_BUDGET } from "@/cli/ui/theme";
import type { Choice, OutputEntry } from "@/cli/ui/types";

// Singleton guard to prevent accidental double instantiation
let instanceExists = false;

/**
 * Ink render options for the terminal UI.
 *
 * IMPORTANT: Do NOT enable `incrementalRendering`. It causes Ink's Yoga
 * layout engine to miscompute available widths, which:
 *   1. Breaks interactive select/wizard prompts (arrow keys emit newlines)
 *   2. Aggressively truncates multi-line ANSI content (diffs disappear)
 *
 * Exported for testability — see terminal.test.ts regression tests.
 */
export const INK_RENDER_OPTIONS = {
  patchConsole: false,
  exitOnCtrlC: false,
} as const;

export { maskSecret };

/**
 * Width offset used when wrapping user-echo messages.
 *
 * Accounts for the App container's `paddingX={3}` (6 chars total) plus the
 * "› " icon + space rendered by OutputEntryView's user-entry styling
 * (2 chars). Centralized so the `ask("You:")` resolve path, the `user()`
 * method and answered pickers all wrap at the same column.
 */
const USER_ECHO_WIDTH_OFFSET = 8;

/**
 * Push a `You: <message>` entry into scrollback. Shared by the chat
 * `ask()` resolve handler and by `terminalService.user()` so the visual
 * styling stays in one place.
 */
function printUserMessage(message: string): void {
  // No inline color — OutputEntryView owns user styling (brass rail + text).
  const wrapped = wrapToWidth(message, getTerminalWidth() - USER_ECHO_WIDTH_OFFSET);
  store.printOutput({
    type: "user",
    message: wrapped,
    meta: { plainText: message }, // unwrapped source for non-Ink renderers
    timestamp: new Date(),
  });
}

/**
 * Close the active prompt and leave `<message> <answer>` in scrollback so the
 * transcript records what the user picked.
 */
function closePromptWithAnswer(message: string, answer: string): void {
  store.setPrompt(null);
  store.printOutput({
    type: "log",
    message: wrapToWidth(
      `${message} ${CHALK_THEME.primary(answer)}`,
      getTerminalWidth() - USER_ECHO_WIDTH_OFFSET,
    ),
    timestamp: new Date(),
  });
}

/** Close the active prompt after the user pressed Escape. */
function closePromptCancelled(message: string): void {
  store.setPrompt(null);
  store.printOutput({
    type: "log",
    message: `${message} ${chalk.dim("(cancelled)")}`,
    timestamp: new Date(),
  });
}

type PromptChoiceInput<T> = string | PromptChoice<T>;

function normalizeChoices<T>(choices: readonly PromptChoiceInput<T>[]): Choice<T>[] {
  return choices.map((choice) =>
    typeof choice === "string"
      ? { label: choice, value: choice as unknown as T }
      : {
          label: choice.name,
          value: choice.value,
          ...(choice.description === undefined ? {} : { description: choice.description }),
          ...(choice.disabled === true ? { disabled: true } : {}),
          ...(choice.tag === undefined ? {} : { tag: choice.tag }),
          ...(choice.tagTone === undefined ? {} : { tagTone: choice.tagTone }),
        },
  );
}

/**
 * Ink-based Terminal Service Implementation
 *
 * This service is a singleton - only one instance should exist at a time.
 * Creating a second instance while one is active will throw an error.
 */
export class InkTerminalService implements TerminalService {
  readonly isInteractive = true;

  private inkInstance: ReturnType<typeof render> | null = null;
  private fullscreen: FullscreenHandle | null = null;
  private fallbackScheduled = false;
  private disposed = false;
  private unregisterRendererFallback: (() => void) | null = null;

  constructor(options: { fullscreen?: boolean } = {}) {
    // Guard against multiple instantiation
    if (instanceExists) {
      throw new Error(
        "InkTerminalService is a singleton. An instance already exists. " +
          "Call cleanup() on the existing instance before creating a new one.",
      );
    }

    if (options.fullscreen === false) {
      this.mountInk();
    } else {
      setActiveKeymap("fullscreen");
      this.fullscreen = mountFullscreenApp({
        onFailure: this.fallbackToInk,
      });
      this.unregisterRendererFallback = store.registerRendererFallbackHandler(this.fallbackToInk);
    }
    instanceExists = true;
  }

  private fallbackToInk = (): void => {
    if (this.fallbackScheduled || this.disposed || this.inkInstance !== null) return;
    this.fallbackScheduled = true;
    queueMicrotask(() => {
      this.fallbackScheduled = false;
      if (this.disposed || this.inkInstance !== null) return;
      this.fullscreen?.release();
      this.fullscreen = null;
      this.mountInk();
    });
  };

  private mountInk(): void {
    if (this.inkInstance !== null) return;
    setActiveKeymap("classic");
    this.inkInstance = render(
      React.createElement(
        TerminalDimensionsProvider,
        null,
        React.createElement(InputProvider, null, React.createElement(App)),
      ),
      INK_RENDER_OPTIONS,
    );
  }

  /**
   * Cleanup method to unmount the Ink app
   * Called when the command completes
   */
  cleanup(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unregisterRendererFallback?.();
    this.unregisterRendererFallback = null;
    if (this.fullscreen) {
      // Releases the alternate screen, the cursor and raw mode. Idempotent, so
      // it is safe if a signal handler already ran.
      this.fullscreen.release();
      this.fullscreen = null;
    }
    if (this.inkInstance) {
      this.inkInstance.unmount();
      this.inkInstance = null;
    }
    // Reset singleton so a new instance can be created if needed
    instanceExists = false;
  }

  // Basic Logging Methods

  info(message: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      store.printOutput({ type: "info", message, timestamp: new Date() });
    });
  }

  success(message: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      store.printOutput({ type: "success", message, timestamp: new Date() });
    });
  }

  error(message: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      store.printOutput({ type: "error", message, timestamp: new Date() });
    });
  }

  warn(message: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      store.printOutput({ type: "warn", message, timestamp: new Date() });
    });
  }

  log(message: TerminalOutput): Effect.Effect<string | undefined, never> {
    return Effect.sync(() => {
      // A report travels as data so the fullscreen interface can set it in its own
      // voice; the styled string is what the scrollback renderer prints.
      const entry: OutputEntry = isTerminalReport(message)
        ? {
            type: "log",
            message: reportAnsiText(message, getTerminalWidth() - PADDING_BUDGET),
            timestamp: new Date(),
            meta: { report: message, plainText: reportPlainText(message, getGlyphs()) },
          }
        : { type: "log", message, timestamp: new Date() };
      const logId = store.printOutput(entry);
      return logId;
    });
  }

  user(message: string): Effect.Effect<void, never> {
    return Effect.sync(() => printUserMessage(message));
  }

  debug(message: string, meta?: Record<string, unknown>): Effect.Effect<void, never> {
    return Effect.sync(() => {
      store.printOutput({
        type: "debug",
        message,
        timestamp: new Date(),
        ...(meta ? { meta } : {}),
      });
    });
  }

  heading(message: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      // Treating heading as a special log or just a log for now,
      // could be enhanced in UI to support multiple types
      store.printOutput({ type: "log", message: `\n${message}\n`, timestamp: new Date() });
    });
  }

  list(items: string[]): Effect.Effect<void, never> {
    return Effect.sync(() => {
      items.forEach((item) => {
        store.printOutput({ type: "log", message: `  • ${item}`, timestamp: new Date() });
      });
    });
  }

  clear(): Effect.Effect<void, never> {
    return Effect.sync(() => {
      // Clear visible screen + scrollback buffer, then reset UI state.
      // console.clear() must come BEFORE store.clearOutputs() because
      // the store reset changes <Static>'s React key (forcing a remount),
      // and any content Ink already wrote to stdout needs to be erased
      // before that remount produces new output.
      console.clear();
      store.clearOutputs();
    });
  }

  // Interactive Methods

  ask(
    message: string,
    options?: {
      defaultValue?: string;
      validate?: (input: string) => boolean | string;
      commandSuggestions?: boolean;
      cancellable?: boolean;
      simple?: boolean;
      hidden?: boolean;
      keys?: readonly string[];
      placeholder?: string;
      secret?: boolean;
      step?: PromptStep;
    },
  ): Effect.Effect<string | undefined, never> {
    return Effect.async<string | undefined>((resume) => {
      const validateFn = options?.validate;
      const isCancellable = options?.cancellable === true || options?.secret === true;
      const isSimple = options?.simple === true;
      const isHidden = options?.hidden === true;
      const isSecret = options?.secret === true;
      const placeholder = options?.placeholder;

      const promptType = isHidden ? "hidden" : isSimple ? "text" : "chat";

      const promptState: {
        type: "text" | "chat" | "hidden";
        message: string;
        options?: {
          defaultValue?: string;
          validate?: (input: string) => boolean | string;
          commandSuggestions?: boolean;
          placeholder?: string;
          secret?: boolean;
          step?: PromptStep;
        };
        resolve: (val: unknown) => void;
        reject?: () => void;
      } = {
        type: promptType,
        message,
        ...(options
          ? {
              options: {
                ...(options.defaultValue !== undefined
                  ? { defaultValue: options.defaultValue }
                  : {}),
                ...(validateFn ? { validate: validateFn } : {}),
                ...(options.commandSuggestions === true ? { commandSuggestions: true } : {}),
                ...(placeholder ? { placeholder } : {}),
                ...(isSecret ? { secret: true } : {}),
                ...(options.keys ? { keys: options.keys } : {}),
                ...(options.step === undefined ? {} : { step: options.step }),
              },
            }
          : {}),
        resolve: (val: unknown) => {
          // The Prompt component validates before calling resolve, so we can trust the input
          const inputValue = String(val);
          store.setPrompt(null);
          if (isHidden) {
            resume(Effect.succeed(inputValue));
            return;
          }
          // Pre-wrap user message to fit terminal width, consistent with how
          // agent responses are pre-wrapped. The offset accounts for App paddingX=3
          // (6 chars) + the "›" icon + space (2 chars) = 8 chars total.
          const displayValue = isSecret ? maskSecret(inputValue) : inputValue;
          // For chat-type prompts the visual "You:" prefix already comes from
          // OutputEntryView's user-entry styling; including the prompt's own
          // "You:" label here would double it up in scrollback. For non-chat
          // prompts (API key entry, named fields, etc.) the label is genuine
          // scrollback context, so keep it.
          if (promptType === "chat") {
            store.pushInputHistory(inputValue);
            printUserMessage(displayValue);
          } else {
            const rawMessage = `${message} ${CHALK_THEME.primary(displayValue)}`;
            store.printOutput({
              type: "user",
              message: wrapToWidth(rawMessage, getTerminalWidth() - USER_ECHO_WIDTH_OFFSET),
              meta: { plainText: `${message} ${displayValue}` },
              timestamp: new Date(),
            });
          }
          resume(Effect.succeed(inputValue));
        },
      };

      // Add reject handler if cancellable
      if (isCancellable) {
        promptState.reject = () => {
          closePromptCancelled(message);
          resume(Effect.succeed(undefined));
        };
      }

      store.setPrompt(promptState);
    });
  }

  password(
    message: string,
    options?: {
      validate?: (input: string) => boolean | string;
    },
  ): Effect.Effect<string, never> {
    return Effect.async((resume) => {
      // Store the validate function to ensure it's properly passed to the prompt
      const validateFn = options?.validate;

      const promptState = {
        type: "password" as const,
        message,
        ...(options && validateFn ? { options: { validate: validateFn } } : {}),
        resolve: (val: unknown) => {
          // The Prompt component validates before calling resolve, so we can trust the input
          const inputValue = String(val);
          store.setPrompt(null);
          store.printOutput({
            type: "log",
            message: `${message} ${maskSecret(inputValue)}`,
            timestamp: new Date(),
          });
          resume(Effect.succeed(inputValue));
        },
      };

      store.setPrompt(promptState);
    });
  }

  select<T = string>(
    message: string,
    options: {
      choices: readonly PromptChoiceInput<T>[];
      default?: T;
      customAnswer?: (text: string) => T;
      step?: PromptStep;
    },
  ): Effect.Effect<T | undefined, never> {
    return Effect.async<T | undefined>((resume) => {
      const choices = normalizeChoices(options.choices);
      const customAnswer = options.customAnswer;
      store.setPrompt({
        type: "select",
        message,
        options: {
          choices,
          ...(options.default === undefined ? {} : { defaultSelected: options.default }),
          ...(options.step === undefined ? {} : { step: options.step }),
          ...(customAnswer === undefined
            ? {}
            : {
                resolveTypedAnswer: (text: string) => {
                  closePromptWithAnswer(message, text);
                  resume(Effect.succeed(customAnswer(text)));
                },
              }),
        },
        resolve: (val: unknown) => {
          const choice = choices.find((c) => c.value === val);
          closePromptWithAnswer(message, choice?.label ?? "");
          resume(Effect.succeed(val as T));
        },
        reject: () => {
          closePromptCancelled(message);
          resume(Effect.succeed(undefined));
        },
      });
    });
  }

  confirm(
    message: string,
    defaultValue: boolean = false,
  ): Effect.Effect<boolean | undefined, never> {
    return Effect.async<boolean | undefined>((resume) => {
      store.setPrompt({
        type: "confirm",
        message,
        options: { defaultValue },
        resolve: (val: unknown) => {
          closePromptWithAnswer(message, val ? "Yes" : "No");
          resume(Effect.succeed(val as boolean));
        },
        reject: () => {
          closePromptCancelled(message);
          resume(Effect.succeed(undefined));
        },
      });
    });
  }

  search<T = string>(
    message: string,
    options: {
      choices: readonly PromptChoiceInput<T>[];
      placeholder?: string;
      step?: PromptStep;
    },
  ): Effect.Effect<T | undefined, never> {
    return Effect.async<T | undefined>((resume) => {
      const choices = normalizeChoices(options.choices);
      store.setPrompt({
        type: "search",
        message,
        options: {
          choices,
          placeholder: options.placeholder,
          ...(options.step === undefined ? {} : { step: options.step }),
        },
        resolve: (val: unknown) => {
          const choice = choices.find((c) => c.value === val);
          closePromptWithAnswer(message, choice?.label ?? "");
          resume(Effect.succeed(val as T));
        },
        reject: () => {
          closePromptCancelled(message);
          resume(Effect.succeed(undefined));
        },
      });
    });
  }

  checkbox<T = string>(
    message: string,
    options: {
      choices: readonly PromptChoiceInput<T>[];
      default?: readonly T[];
      step?: PromptStep;
    },
  ): Effect.Effect<readonly T[] | undefined, never> {
    return Effect.async<readonly T[] | undefined>((resume) => {
      const choices = normalizeChoices(options.choices);
      store.setPrompt({
        type: "checkbox",
        message,
        options: {
          choices,
          defaultSelected: options.default,
          ...(options.step === undefined ? {} : { step: options.step }),
        },
        resolve: (val: unknown) => {
          const selectedValues = val as readonly T[];
          const selectedLabels = selectedValues
            .map((value) => choices.find((choice) => choice.value === value)?.label)
            .filter(Boolean)
            .join(", ");
          closePromptWithAnswer(message, `[${selectedLabels}]`);
          resume(Effect.succeed(selectedValues));
        },
        reject: () => {
          closePromptCancelled(message);
          resume(Effect.succeed(undefined));
        },
      });
    });
  }

  setTitle(title: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      // Use OSC 0 sequence to set both icon name and window/tab title
      // Format: ESC]0;title BEL
      // \x1b is ESC, \x07 is BEL (bell)
      // This is widely supported across modern terminals (Warp, iTerm2, WezTerm, Alacritty, etc.)
      process.stdout.write(`\x1b]0;${title}\x07`);
    });
  }
}

/** Where the plain terminal reads answers and writes output. Defaults to the process streams. */
export interface PlainTerminalStreams {
  readonly input?: NodeJS.ReadableStream & { readonly isTTY?: boolean };
  readonly output?: { write(chunk: string): unknown };
  readonly errorOutput?: { write(chunk: string): unknown };
}

/**
 * Plain Terminal Service for non-TTY environments (CI, piped output, cron) and
 * print-and-exit modes (`--no-tui`, raw and quiet output).
 *
 * Writes without Ink, avoiding the raw mode error that occurs when Ink tries to
 * call setRawMode on a non-TTY stdin. Regular output goes to stdout; errors,
 * warnings and debug lines go to stderr so a pipeline's data stays clean.
 *
 * Prompts never invent an answer. `ask` and `password` read the next line from
 * stdin and resolve `undefined` once stdin has ended. Menus and confirmations
 * (`select`, `search`, `checkbox`, `confirm`) cannot be answered from a line
 * stream, so they report that on stderr and resolve `undefined`, which every
 * caller treats as a cancellation.
 */
export class PlainTerminalService implements TerminalService {
  readonly isInteractive = false;

  private readonly input: NodeJS.ReadableStream & { readonly isTTY?: boolean };
  private readonly output: { write(chunk: string): unknown };
  private readonly errorOutput: { write(chunk: string): unknown };
  private lineSource: LineSource | undefined;

  constructor(streams: PlainTerminalStreams = {}) {
    this.input = streams.input ?? process.stdin;
    this.output = streams.output ?? process.stdout;
    this.errorOutput = streams.errorOutput ?? process.stderr;
  }

  private write(message: string): void {
    this.output.write(`${message}\n`);
  }

  private writeError(message: string): void {
    this.errorOutput.write(`${message}\n`);
  }

  /** Read one line, echoing the prompt to stderr only when a person is typing it. */
  private readLine(message: string): Promise<string | undefined> {
    if (this.input.isTTY === true) {
      this.errorOutput.write(`${message} `);
    }
    this.lineSource ??= createLineSource(this.input);
    return this.lineSource.next();
  }

  private unanswerable<T>(message: string): Effect.Effect<T | undefined, never> {
    return Effect.sync(() => {
      this.writeError(`⚠ Skipped "${message}": answering it needs an interactive terminal.`);
      return undefined;
    });
  }

  info(message: string): Effect.Effect<void, never> {
    return Effect.sync(() => this.write(`ℹ ${message}`));
  }

  success(message: string): Effect.Effect<void, never> {
    return Effect.sync(() => this.write(`✓ ${message}`));
  }

  error(message: string): Effect.Effect<void, never> {
    return Effect.sync(() => this.writeError(`✗ ${message}`));
  }

  warn(message: string): Effect.Effect<void, never> {
    return Effect.sync(() => this.writeError(`⚠ ${message}`));
  }

  log(message: TerminalOutput): Effect.Effect<string | undefined, never> {
    return Effect.sync(() => {
      if (typeof message === "string") {
        this.write(message);
      } else if (isTerminalReport(message)) {
        this.write(reportPlainText(message, getGlyphs()));
      }
      // Ink nodes are silently ignored in plain terminal mode
      return undefined;
    });
  }

  user(message: string): Effect.Effect<void, never> {
    return Effect.sync(() => this.write(`You: ${message}`));
  }

  debug(message: string, _meta?: Record<string, unknown>): Effect.Effect<void, never> {
    return Effect.sync(() => this.writeError(`[debug] ${message}`));
  }

  heading(message: string): Effect.Effect<void, never> {
    return Effect.sync(() => this.write(`\n${message}\n`));
  }

  list(items: string[]): Effect.Effect<void, never> {
    return Effect.sync(() => {
      for (const item of items) {
        this.write(`  • ${item}`);
      }
    });
  }

  clear(): Effect.Effect<void, never> {
    return Effect.void;
  }

  ask(
    message: string,
    options?: Parameters<TerminalService["ask"]>[1],
  ): Effect.Effect<string | undefined, never> {
    return Effect.promise(async () => {
      const line = await this.readLine(message);
      if (line === undefined) {
        return undefined;
      }
      const verdict = options?.validate?.(line) ?? true;
      if (verdict !== true) {
        this.writeError(`✗ ${typeof verdict === "string" ? verdict : "Invalid input."}`);
        return undefined;
      }
      return line;
    });
  }

  password(
    message: string,
    options?: { validate?: (input: string) => boolean | string },
  ): Effect.Effect<string | undefined, never> {
    return this.ask(message, options);
  }

  select<T = string>(message: string, _options?: object): Effect.Effect<T | undefined, never> {
    return this.unanswerable<T>(message);
  }

  confirm(message: string, _defaultValue?: boolean): Effect.Effect<boolean | undefined, never> {
    return this.unanswerable<boolean>(message);
  }

  search<T = string>(message: string, _options?: object): Effect.Effect<T | undefined, never> {
    return this.unanswerable<T>(message);
  }

  checkbox<T = string>(
    message: string,
    _options?: object,
  ): Effect.Effect<readonly T[] | undefined, never> {
    return this.unanswerable<readonly T[]>(message);
  }

  setTitle(_title: string): Effect.Effect<void, never> {
    return Effect.void;
  }

  cleanup(): void {
    this.lineSource?.close();
  }
}

/** Create the interactive terminal service layer. */
export function createTerminalServiceLayer(
  options: { fullscreen?: boolean } = {},
): Layer.Layer<TerminalService, never, never> {
  return Layer.effect(
    TerminalServiceTag,
    Effect.sync(() => new InkTerminalService(options)),
  );
}

/**
 * Create a plain terminal service layer.
 *
 * Always uses PlainTerminalService regardless of TTY status.
 * Use this for `--output quiet` mode and scheduled workflow runs where
 * no interactive UI is needed.
 */
export function createPlainTerminalServiceLayer(): Layer.Layer<TerminalService, never, never> {
  return Layer.effect(
    TerminalServiceTag,
    Effect.sync(() => new PlainTerminalService()),
  );
}
