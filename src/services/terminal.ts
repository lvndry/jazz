import chalk from "chalk";
import { Effect, Layer } from "effect";
import { render } from "ink";
import React from "react";
import { wrapToWidth, getTerminalWidth } from "@/cli/presentation/markdown-formatter";
import App from "@/cli/ui/App";
import { InputProvider } from "@/cli/ui/contexts/InputContext";
import { TerminalDimensionsProvider } from "@/cli/ui/contexts/TerminalDimensionsContext";
import { store } from "@/cli/ui/store";
import type { OutputEntry } from "@/cli/ui/types";
import {
  TerminalServiceTag,
  type TerminalOutput,
  type TerminalService,
} from "@/core/interfaces/terminal";

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

/**
 * Ink-based Terminal Service Implementation
 *
 * This service is a singleton - only one instance should exist at a time.
 * Creating a second instance while one is active will throw an error.
 */
export class InkTerminalService implements TerminalService {
  private inkInstance: ReturnType<typeof render> | null = null;

  constructor() {
    // Guard against multiple instantiation
    if (instanceExists) {
      throw new Error(
        "InkTerminalService is a singleton. An instance already exists. " +
          "Call cleanup() on the existing instance before creating a new one.",
      );
    }

    // Initialize the Ink app on service creation
    // patchConsole: false prevents Ink from intercepting console.* methods,
    // which can cause flickering when external code writes to console during renders
    // Wrap App with InputProvider to provide the input service context
    this.inkInstance = render(
      React.createElement(
        TerminalDimensionsProvider,
        null,
        React.createElement(InputProvider, null, React.createElement(App)),
      ),
      INK_RENDER_OPTIONS,
    );
    instanceExists = true;
  }

  /**
   * Cleanup method to unmount the Ink app
   * Called when the command completes
   */
  cleanup(): void {
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
      const entry: OutputEntry = {
        type: "log",
        message,
        timestamp: new Date(),
      };
      const logId = store.printOutput(entry);
      return logId;
    });
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
    },
  ): Effect.Effect<string | undefined, never> {
    return Effect.async<string, Error>((resume) => {
      const validateFn = options?.validate;
      const isCancellable = options?.cancellable === true;
      const isSimple = options?.simple === true;
      const isHidden = options?.hidden === true;

      const promptType = isHidden ? "hidden" : isSimple ? "text" : "chat";

      const promptState: {
        type: "text" | "chat" | "hidden";
        message: string;
        options?: {
          defaultValue?: string;
          validate?: (input: string) => boolean | string;
          commandSuggestions?: boolean;
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
              },
            }
          : {}),
        resolve: (val: unknown) => {
          // The Prompt component validates before calling resolve, so we can trust the input
          const inputValue = String(val);
          store.setPrompt(null);
          // Pre-wrap user message to fit terminal width, consistent with how
          // agent responses are pre-wrapped. The offset accounts for App paddingX=3
          // (6 chars) + the "›" icon + space (2 chars) = 8 chars total.
          const rawMessage = `${message} ${chalk.green(inputValue)}`;
          const available = getTerminalWidth() - 8;
          store.printOutput({
            type: "user",
            message: wrapToWidth(rawMessage, available),
            timestamp: new Date(),
          });
          resume(Effect.succeed(inputValue));
        },
      };

      // Add reject handler if cancellable
      if (isCancellable) {
        promptState.reject = () => {
          store.setPrompt(null);
          store.printOutput({
            type: "log",
            message: `${message} ${chalk.dim("(cancelled)")}`,
            timestamp: new Date(),
          });
          resume(Effect.fail(new Error("PromptCancelled")));
        };
      }

      store.setPrompt(promptState);
    }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
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
          store.printOutput({ type: "log", message: `${message} *****`, timestamp: new Date() });
          resume(Effect.succeed(inputValue));
        },
      };

      store.setPrompt(promptState);
    });
  }

  select<T = string>(
    message: string,
    options: {
      choices: readonly (
        | string
        | { name: string; value: T; description?: string; disabled?: boolean }
      )[];
      default?: T;
    },
  ): Effect.Effect<T | undefined, never> {
    return Effect.async<T, Error>((resume) => {
      // Normalize choices for Ink SelectInput
      const choices = options.choices.map((choice) => {
        if (typeof choice === "string")
          return { label: choice, value: choice as unknown as T, disabled: false };
        return { label: choice.name, value: choice.value, disabled: choice.disabled ?? false };
      });

      store.setPrompt({
        type: "select",
        message,

        options: { choices: choices },
        resolve: (val: unknown) => {
          store.setPrompt(null);
          // find label for log
          const choice = choices.find((c) => c.value === val);
          const rawMsg = `${message} ${chalk.green(choice?.label ?? "")}`;
          store.printOutput({
            type: "log",
            message: wrapToWidth(rawMsg, getTerminalWidth() - 8),
            timestamp: new Date(),
          });
          resume(Effect.succeed(val as T));
        },
        reject: () => {
          store.setPrompt(null);
          store.printOutput({
            type: "log",
            message: `${message} ${chalk.dim("(cancelled)")}`,
            timestamp: new Date(),
          });
          resume(Effect.fail(new Error("PromptCancelled")));
        },
      });
    }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
  }

  confirm(message: string, defaultValue: boolean = false): Effect.Effect<boolean, never> {
    return Effect.async((resume) => {
      store.setPrompt({
        type: "confirm",
        message,
        options: { defaultValue },
        resolve: (val: unknown) => {
          store.setPrompt(null);
          const rawMsg = `${message} ${chalk.green(val ? "Yes" : "No")}`;
          store.printOutput({
            type: "log",
            message: wrapToWidth(rawMsg, getTerminalWidth() - 8),
            timestamp: new Date(),
          });
          resume(Effect.succeed(val as boolean));
        },
      });
    });
  }

  search<T = string>(
    message: string,
    options: {
      choices: readonly (string | { name: string; value: T; description?: string })[];
    },
  ): Effect.Effect<T | undefined, never> {
    return Effect.async<T, Error>((resume) => {
      // Normalize choices for SearchSelect
      const choices = options.choices.map((c) => {
        if (typeof c === "string") return { label: c, value: c as unknown as T };
        return { label: c.name, value: c.value };
      });

      store.setPrompt({
        type: "search",
        message,
        options: { choices },
        resolve: (val: unknown) => {
          store.setPrompt(null);
          // Find label for log
          const choice = choices.find((c) => c.value === val);
          const rawMsg = `${message} ${chalk.green(choice?.label ?? "")}`;
          store.printOutput({
            type: "log",
            message: wrapToWidth(rawMsg, getTerminalWidth() - 8),
            timestamp: new Date(),
          });
          resume(Effect.succeed(val as T));
        },
        reject: () => {
          store.setPrompt(null);
          store.printOutput({
            type: "log",
            message: `${message} ${chalk.dim("(cancelled)")}`,
            timestamp: new Date(),
          });
          resume(Effect.fail(new Error("PromptCancelled")));
        },
      });
    }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
  }

  checkbox<T = string>(
    message: string,
    options: {
      choices: readonly (string | { name: string; value: T; description?: string })[];
      default?: readonly T[];
    },
  ): Effect.Effect<readonly T[], never> {
    return Effect.async((resume) => {
      // Normalize choices
      const choices = options.choices.map((c) => {
        if (typeof c === "string") return { label: c, value: c as unknown as T };
        return { label: c.name, value: c.value };
      });

      store.setPrompt({
        type: "checkbox",
        message,
        options: { choices, defaultSelected: options.default },
        resolve: (val: unknown) => {
          store.setPrompt(null);
          // val should be an array of values
          const selectedValues = val as T[];
          const selectedLabels = selectedValues
            .map((v) => {
              const c = choices.find((ch) => ch.value === v);
              return c?.label;
            })
            .filter(Boolean)
            .join(", ");

          const rawMsg = `${message} ${chalk.green(`[${selectedLabels}]`)}`;
          store.printOutput({
            type: "log",
            message: wrapToWidth(rawMsg, getTerminalWidth() - 8),
            timestamp: new Date(),
          });
          resume(Effect.succeed(val as readonly T[]));
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

/**
 * Plain Terminal Service for non-TTY environments (CI, piped output, cron).
 *
 * Writes directly to stdout without Ink, avoiding the raw mode error that
 * occurs when Ink tries to call setRawMode on a non-TTY stdin.
 * Interactive prompts return sensible defaults (empty string, false, first choice).
 */
export class PlainTerminalService implements TerminalService {
  private write(message: string): void {
    process.stdout.write(`${message}\n`);
  }

  info(message: string): Effect.Effect<void, never> {
    return Effect.sync(() => this.write(`ℹ ${message}`));
  }

  success(message: string): Effect.Effect<void, never> {
    return Effect.sync(() => this.write(`✓ ${message}`));
  }

  error(message: string): Effect.Effect<void, never> {
    return Effect.sync(() => this.write(`✗ ${message}`));
  }

  warn(message: string): Effect.Effect<void, never> {
    return Effect.sync(() => this.write(`⚠ ${message}`));
  }

  log(message: TerminalOutput): Effect.Effect<string | undefined, never> {
    return Effect.sync(() => {
      if (typeof message === "string") {
        this.write(message);
      }
      // Ink nodes are silently ignored in plain terminal mode
      return undefined;
    });
  }

  debug(message: string, _meta?: Record<string, unknown>): Effect.Effect<void, never> {
    return Effect.sync(() => this.write(`[debug] ${message}`));
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

  // Interactive methods return defaults — non-interactive mode cannot prompt
  ask(
    _message: string,
    options?: { defaultValue?: string },
  ): Effect.Effect<string | undefined, never> {
    return Effect.succeed(options?.defaultValue ?? undefined);
  }

  password(_message: string): Effect.Effect<string, never> {
    return Effect.succeed("");
  }

  select<T = string>(
    _message: string,
    options: {
      choices: readonly (
        | string
        | { name: string; value: T; description?: string; disabled?: boolean }
      )[];
      default?: T;
    },
  ): Effect.Effect<T | undefined, never> {
    if (options.default !== undefined) return Effect.succeed(options.default);
    const first = options.choices[0];
    if (!first) return Effect.succeed(undefined);
    if (typeof first === "string") return Effect.succeed(first as unknown as T);
    return Effect.succeed(first.value);
  }

  confirm(_message: string, defaultValue: boolean = false): Effect.Effect<boolean, never> {
    return Effect.succeed(defaultValue);
  }

  search<T = string>(
    _message: string,
    options: {
      choices: readonly (string | { name: string; value: T; description?: string })[];
    },
  ): Effect.Effect<T | undefined, never> {
    const first = options.choices[0];
    if (!first) return Effect.succeed(undefined);
    if (typeof first === "string") return Effect.succeed(first as unknown as T);
    return Effect.succeed(first.value);
  }

  checkbox<T = string>(
    _message: string,
    options: {
      choices: readonly (string | { name: string; value: T; description?: string })[];
      default?: readonly T[];
    },
  ): Effect.Effect<readonly T[], never> {
    return Effect.succeed(options.default ?? []);
  }

  setTitle(_title: string): Effect.Effect<void, never> {
    return Effect.void;
  }
}

/**
 * Create the terminal service layer.
 *
 * Uses the Ink-based terminal when both stdout and stdin are TTYs (interactive terminal).
 * Falls back to a plain terminal service in non-TTY environments (CI, piped output, cron)
 * to avoid Ink's raw mode error.
 */
export function createTerminalServiceLayer(): Layer.Layer<TerminalService, never, never> {
  const isTTY = process.stdout.isTTY && process.stdin.isTTY;

  return Layer.effect(
    TerminalServiceTag,
    Effect.sync(() => (isTTY ? new InkTerminalService() : new PlainTerminalService())),
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
