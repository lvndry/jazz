import { Effect, Layer } from "effect";
import { render } from "ink";
import React from "react";
import App, { store } from "../cli/ui/App";
import {
  TerminalServiceTag,
  type TerminalOutput,
  type TerminalService,
} from "../core/interfaces/terminal";

/**
 * Ink-based Terminal Service Implementation
 *
 */
export class InkTerminalService implements TerminalService {
  constructor() {
    // Initialize the Ink app on service creation
    // We strictly assume this service is singleton and created once at startup
    render(React.createElement(App));
  }

  // Basic Logging Methods

  info(message: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      store.addLog({ type: "info", message, timestamp: new Date() });
    });
  }

  success(message: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      store.addLog({ type: "success", message, timestamp: new Date() });
    });
  }

  error(message: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      store.addLog({ type: "error", message, timestamp: new Date() });
    });
  }

  warn(message: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      store.addLog({ type: "warn", message, timestamp: new Date() });
    });
  }

  log(message: TerminalOutput): Effect.Effect<void, never> {
    return Effect.sync(() => {
      store.addLog({ type: "log", message, timestamp: new Date() });
    });
  }

  debug(message: string, meta?: Record<string, unknown>): Effect.Effect<void, never> {
    return Effect.sync(() => {
      store.addLog({
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
      store.addLog({ type: "log", message: `\n${message}\n`, timestamp: new Date() });
    });
  }

  list(items: string[]): Effect.Effect<void, never> {
    return Effect.sync(() => {
      items.forEach((item) => {
        store.addLog({ type: "log", message: `  • ${item}`, timestamp: new Date() });
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
          store.addLog({
            type: "user",
            message: `${message} ${inputValue}`,
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
          store.addLog({ type: "log", message: `${message} *****`, timestamp: new Date() });
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
  ): Effect.Effect<T, never> {
    return Effect.async((resume) => {
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
          store.addLog({
            type: "log",
            message: `${message} ${choice?.label}`,
            timestamp: new Date(),
          });
          resume(Effect.succeed(val as T));
        },
      });
    });
  }

  confirm(message: string, defaultValue: boolean = false): Effect.Effect<boolean, never> {
    return Effect.async((resume) => {
      store.setPrompt({
        type: "confirm",
        message,
        options: { defaultValue },
        resolve: (val: unknown) => {
          store.setPrompt(null);
          store.addLog({
            type: "log",
            message: `${message} ${val ? "Yes" : "No"}`,
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
  ): Effect.Effect<T, never> {
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

          store.addLog({
            type: "log",
            message: `${message} [${selectedLabels}]`,
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
