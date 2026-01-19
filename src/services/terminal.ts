import App, { store } from "@/cli/ui/App";
import type { LogEntryInput } from "@/cli/ui/types";
import {
  TerminalServiceTag,
  type TerminalOutput,
  type TerminalService,
} from "@/core/interfaces/terminal";
import chalk from "chalk";
import { Effect, Layer } from "effect";
import { render } from "ink";
import React from "react";

// Singleton guard to prevent accidental double instantiation
let instanceExists = false;

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
    this.inkInstance = render(React.createElement(App));
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

  log(message: TerminalOutput, id?: string): Effect.Effect<string | undefined, never> {
    return Effect.sync(() => {
      const entry: LogEntryInput = {
        type: "log",
        message,
        timestamp: new Date(),
        ...(id ? { id } : {}),
      };
      const logId = store.printOutput(entry);
      return logId;
    });
  }

  updateLog(id: string, message: TerminalOutput): Effect.Effect<void, never> {
    return Effect.sync(() => {
      store.updateOutput(id, { message, timestamp: new Date() });
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
      console.clear();
      store.clearLogs();
    });
  }

  // Interactive Methods

  ask(
    message: string,
    options?: {
      defaultValue?: string;
      validate?: (input: string) => boolean | string;
    },
  ): Effect.Effect<string, never> {
    return Effect.async((resume) => {
      // Store the validate function to ensure it's properly passed to the prompt
      const validateFn = options?.validate;

      const promptState: {
        type: "text";
        message: string;
        options?: { defaultValue?: string; validate?: (input: string) => boolean | string };
        resolve: (val: unknown) => void;
      } = {
        type: "text",
        message,
        ...(options
          ? {
              options: {
                ...(options.defaultValue !== undefined
                  ? { defaultValue: options.defaultValue }
                  : {}),
                ...(validateFn ? { validate: validateFn } : {}),
              },
            }
          : {}),
        resolve: (val: unknown) => {
          // The Prompt component validates before calling resolve, so we can trust the input
          const inputValue = String(val);
          store.setPrompt(null);
          store.printOutput({
            type: "user",
            message: `${message} ${chalk.green(inputValue)}`,
            timestamp: new Date(),
          });
          resume(Effect.succeed(inputValue));
        },
      };

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
      choices: readonly (string | { name: string; value: T; description?: string })[];
      default?: T;
    },
  ): Effect.Effect<T | undefined, never> {
    return Effect.async<T, Error>((resume) => {
      // Normalize choices for Ink SelectInput
      const choices = options.choices.map((c) => {
        if (typeof c === "string") return { label: c, value: c as unknown as T };
        return { label: c.name, value: c.value };
      });

      store.setPrompt({
        type: "select",
        message,

        options: { choices: choices },
        resolve: (val: unknown) => {
          store.setPrompt(null);
          // find label for log
          const choice = choices.find((c) => c.value === val);
          store.printOutput({
            type: "log",
            message: `${message} ${chalk.green(choice?.label ?? '')}`,
            timestamp: new Date(),
          });
          resume(Effect.succeed(val as T));
        },
        reject: () => {
          store.setPrompt(null);
          store.printOutput({
            type: "log",
            message: `${message} ${chalk.dim('(cancelled)')}`,
            timestamp: new Date(),
          });
          resume(Effect.fail(new Error("PromptCancelled")));
        },
      });
    }).pipe(
      Effect.catchAll(() => Effect.succeed(undefined))
    );
  }

  confirm(message: string, defaultValue: boolean = false): Effect.Effect<boolean, never> {
    return Effect.async((resume) => {
      store.setPrompt({
        type: "confirm",
        message,
        options: { defaultValue },
        resolve: (val: unknown) => {
          store.setPrompt(null);
          store.printOutput({
            type: "log",
            message: `${message} ${chalk.green(val ? "Yes" : "No")}`,
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
    // Basic search implementation mapping to Select for now
    return this.select(message, options);
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

          store.printOutput({
            type: "log",
            message: `${message} ${chalk.green(`[${selectedLabels}]`)}`,
            timestamp: new Date(),
          });
          resume(Effect.succeed(val as readonly T[]));
        },
      });
    });
  }
}

/**
 * Create the terminal service layer
 */
export function createTerminalServiceLayer(): Layer.Layer<TerminalService, never, never> {
  return Layer.effect(
    TerminalServiceTag,
    Effect.sync(() => new InkTerminalService()),
  );
}
