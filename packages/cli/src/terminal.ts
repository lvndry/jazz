/**
 * Implements the terminal port for fullscreen and classic Ink.
 *
 * InkTerminalService accepts an optionally lazy-loaded fullscreen mount. Output
 * publishes to the shared document; fullscreen clear/title invoke the owner's
 * explicit capabilities. Runtime handoff mounts Ink against the same document,
 * and cleanup releases the singleton even when renderer disposal fails.
 */

import {
  TerminalServiceTag,
  type PromptChoice,
  type PromptStep,
  type TerminalOutput,
  type TerminalService,
} from "@jazz/core/interfaces/terminal";
import { Effect, Layer } from "effect";
import { render } from "ink";
import React from "react";
import App from "@/cli/ui/App";
import { InputProvider } from "@/cli/ui/contexts/InputContext";
import { TerminalDimensionsProvider } from "@/cli/ui/contexts/TerminalDimensionsContext";
import type { FullscreenHandle, mountFullscreenApp } from "@/cli/ui/fullscreen/attach";
import { setActiveKeymap } from "@/cli/ui/keymaps";
import { maskSecret } from "@/cli/ui/mask-secret";
import { store } from "@/cli/ui/store";
import { screenReaderRequested } from "@/cli/ui/terminal-capabilities";
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
 * Push a `You: <message>` entry into scrollback. Shared by the chat
 * `ask()` resolve handler and by `terminalService.user()` so the visual
 * styling stays in one place.
 */
function printUserMessage(message: string): void {
  store.printOutput({
    type: "user",
    message,
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
    message: `${message} ${answer}`,
    timestamp: new Date(),
  });
}

/** Close the active prompt after the user pressed Escape. */
function closePromptCancelled(message: string): void {
  store.setPrompt(null);
  store.printOutput({
    type: "log",
    message: `${message} (cancelled)`,
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
          ...(choice.preview === undefined ? {} : { preview: choice.preview }),
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

  /**
   * `mountFullscreen` is the fullscreen interface's mount function, passed in already loaded so
   * the constructor owns the screen before it returns. Without it, Ink renders.
   */
  constructor(options: { mountFullscreen?: typeof mountFullscreenApp } = {}) {
    // Guard against multiple instantiation
    if (instanceExists) {
      throw new Error(
        "InkTerminalService is a singleton. An instance already exists. " +
          "Call cleanup() on the existing instance before creating a new one.",
      );
    }

    if (options.mountFullscreen === undefined) {
      this.mountInk();
    } else {
      setActiveKeymap("fullscreen");
      this.fullscreen = options.mountFullscreen({
        onFailure: this.fallbackToInk,
      });
      this.unregisterRendererFallback = store.registerRendererFallbackHandler(this.fallbackToInk);
    }
    // Either renderer is being watched by a person, so streamed text is paced
    // for reading; a screen reader gets each piece the moment it arrives.
    store.setStreamPacing(!screenReaderRequested());
    instanceExists = true;
  }

  private fallbackToInk = (): void => {
    if (this.fallbackScheduled || this.disposed || this.inkInstance !== null) return;
    this.fallbackScheduled = true;
    queueMicrotask(() => {
      this.fallbackScheduled = false;
      if (this.disposed || this.inkInstance !== null) return;
      const fullscreen = this.fullscreen;
      this.fullscreen = null;
      try {
        fullscreen?.release();
      } catch {
        // Runtime cleanup exhausted its resources; handoff still renders the same document.
      }
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
    store.setStreamPacing(false);
    this.unregisterRendererFallback?.();
    this.unregisterRendererFallback = null;
    try {
      this.fullscreen?.release();
    } finally {
      this.fullscreen = null;
      try {
        this.inkInstance?.unmount();
      } finally {
        this.inkInstance = null;
        instanceExists = false;
      }
    }
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
      const entry: OutputEntry = { type: "log", message, timestamp: new Date() };
      const logId = store.printOutput(entry);
      return logId;
    });
  }

  user(message: string): Effect.Effect<void, never> {
    return Effect.sync(() => printUserMessage(message));
  }

  debug(message: string, _meta?: Record<string, unknown>): Effect.Effect<void, never> {
    return Effect.sync(() => {
      store.printOutput({
        type: "debug",
        message,
        timestamp: new Date(),
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
      if (!this.fullscreen) console.clear();
      store.clearOutputs();
      this.fullscreen?.invalidate();
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
    return Effect.callback<string | undefined>((resume) => {
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
          const displayValue = isSecret ? maskSecret(inputValue) : inputValue;
          // For chat-type prompts the visual "You:" prefix already comes from
          // OutputEntryView's user-entry styling; including the prompt's own
          // "You:" label here would double it up in scrollback. For non-chat
          // prompts (API key entry, named fields, etc.) the label is genuine
          // scrollback context, so keep it.
          if (promptType === "chat") {
            // Slash commands and shell escapes never reach the model's history,
            // so they are recorded here — otherwise ↑ only recalls prose.
            // Secret prompts are masked in the transcript; keeping their raw
            // value would let ↑ paste the secret back into the composer.
            if (!isSecret) {
              store.pushInputHistory(inputValue);
            }
            printUserMessage(displayValue);
          } else {
            const rawMessage = `${message} ${displayValue}`;
            store.printOutput({
              type: "user",
              message: rawMessage,
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
      // Interrupted (the chat starting a turn of its own while idle), the prompt goes away
      // unanswered; the composer keeps whatever was typed in it.
      return Effect.sync(() => store.withdrawPrompt(promptState));
    });
  }

  password(
    message: string,
    options?: {
      validate?: (input: string) => boolean | string;
    },
  ): Effect.Effect<string, never> {
    return Effect.callback((resume) => {
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
    return Effect.callback<T | undefined>((resume) => {
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
    return Effect.callback<boolean | undefined>((resume) => {
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
      remove?: (value: T) => Effect.Effect<void, Error>;
    },
  ): Effect.Effect<T | undefined, never> {
    const remove = options.remove;
    return Effect.callback<T | undefined>((resume) => {
      const choices = normalizeChoices(options.choices);
      store.setPrompt({
        type: "search",
        message,
        options: {
          choices,
          placeholder: options.placeholder,
          ...(options.step === undefined ? {} : { step: options.step }),
          ...(remove === undefined ? {} : { remove: (value: unknown) => remove(value as T) }),
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
    return Effect.callback<readonly T[] | undefined>((resume) => {
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
      if (this.fullscreen) this.fullscreen.setTitle(title);
      else process.stdout.write(`\x1b]0;${title.replace(/\p{Cc}/gu, "")}\x07`);
    });
  }
}

/** Create the interactive terminal service layer. */
export function createTerminalServiceLayer(
  options: { fullscreen?: boolean } = {},
): Layer.Layer<TerminalService, never, never> {
  if (options.fullscreen === false) {
    return Layer.effect(
      TerminalServiceTag,
      Effect.sync(() => new InkTerminalService()),
    );
  }
  // Loaded here rather than imported at the top so Ink and plain sessions never evaluate
  // OpenTUI. Its graph uses top-level await, so it can only be loaded asynchronously.
  return Layer.effect(
    TerminalServiceTag,
    Effect.promise(() => import("@/cli/ui/fullscreen/attach")).pipe(
      Effect.map(
        (fullscreen) => new InkTerminalService({ mountFullscreen: fullscreen.mountFullscreenApp }),
      ),
    ),
  );
}
