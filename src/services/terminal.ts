import {
  checkbox as checkboxPrompt,
  confirm as confirmPrompt,
  input,
  password as passwordPrompt,
  search as searchPrompt,
  select as selectPrompt,
} from "@inquirer/prompts";
import chalk from "chalk";
import { Effect, Layer } from "effect";
import { TerminalServiceTag, type TerminalService } from "../core/interfaces/terminal";

/**
 * Terminal output service implementation for consistent CLI styling
 *
 * Provides a unified interface for terminal output with automatic
 * emoji prefixes, color coding, and formatting.
 */
export class TerminalServiceImpl implements TerminalService {
  constructor() {}

  info(message: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      console.log(chalk.cyan("🔍") + "  " + message);
    });
  }

  success(message: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      console.log(chalk.green("✅") + "  " + message);
    });
  }

  error(message: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      console.log(chalk.red("❌") + "  " + message);
    });
  }

  warn(message: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      console.log(chalk.yellow("⚠️") + "  " + message);
    });
  }

  log(message: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      console.log(message);
    });
  }

  debug(message: string, meta?: Record<string, unknown>): Effect.Effect<void, never> {
    return Effect.sync(() => {
      if (meta) {
        console.debug(chalk.gray.dim(message), meta);
      } else {
        console.debug(chalk.gray.dim(message));
      }
    });
  }

  heading(message: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      console.log();
      console.log(chalk.bold.cyan(message));
      console.log();
    });
  }

  list(items: string[]): Effect.Effect<void, never> {
    return Effect.sync(() => {
      for (const item of items) {
        console.log("   • " + item);
      }
    });
  }

  ask(
    message: string,
    options?: {
      defaultValue?: string;
      validate?: (input: string) => boolean | string;
    },
  ): Effect.Effect<string, never> {
    return Effect.promise(async () => {
      const answer = await input({
        message,
        ...(options?.defaultValue !== undefined ? { default: options.defaultValue } : {}),
        ...(options?.validate !== undefined ? { validate: options.validate } : {}),
      });
      return answer;
    });
  }

  password(message: string): Effect.Effect<string, never> {
    return Effect.promise(async () => {
      const answer = await passwordPrompt({
        message,
      });
      return answer;
    });
  }

  select<T = string>(
    message: string,
    options: {
      choices: readonly (string | { name: string; value: T; description?: string })[];
      default?: T;
    },
  ): Effect.Effect<T, never> {
    return Effect.promise(async () => {
      const answer = await selectPrompt<T>({
        message,
        choices: options.choices as unknown as Parameters<typeof selectPrompt<T>>[0]["choices"],
        ...(options.default !== undefined ? { default: options.default } : {}),
      });
      return answer;
    });
  }

  confirm(message: string, defaultValue: boolean = false): Effect.Effect<boolean, never> {
    return Effect.promise(async () => {
      const answer = await confirmPrompt({
        message,
        default: defaultValue,
      });
      return answer;
    });
  }

  search<T = string>(
    message: string,
    options: {
      choices: readonly (string | { name: string; value: T; description?: string })[];
    },
  ): Effect.Effect<T, never> {
    return Effect.promise(async () => {
      const answer = await searchPrompt<T>({
        message,
        source: (term: string | undefined) => {
          if (!term) {
            return options.choices as unknown as ReturnType<
              Parameters<typeof searchPrompt<T>>[0]["source"]
            >;
          }

          const searchTerm = term.toLowerCase();
          return options.choices.filter((choice) => {
            if (typeof choice === "string") {
              return choice.toLowerCase().includes(searchTerm);
            }

            return (
              choice.name.toLowerCase().includes(searchTerm) ||
              String(choice.value).toLowerCase().includes(searchTerm) ||
              (choice.description?.toLowerCase().includes(searchTerm) ?? false)
            );
          }) as unknown as ReturnType<Parameters<typeof searchPrompt<T>>[0]["source"]>;
        },
      });

      return answer;
    });
  }

  checkbox<T = string>(
    message: string,
    options: {
      choices: readonly (string | { name: string; value: T; description?: string })[];
      default?: readonly T[];
    },
  ): Effect.Effect<readonly T[], never> {
    return Effect.promise(async () => {
      const answer = await checkboxPrompt<T>({
        message,
        choices: options.choices as unknown as Parameters<typeof checkboxPrompt<T>>[0]["choices"],
        ...(options.default !== undefined ? { default: options.default as T[] } : {}),
      });

      return answer;
    });
  }
}

/**
 * Create the terminal service layer
 */
export function createTerminalServiceLayer(): Layer.Layer<TerminalService, never, never> {
  return Layer.succeed(TerminalServiceTag, new TerminalServiceImpl());
}
