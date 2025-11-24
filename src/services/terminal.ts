import {
  confirm as confirmPrompt,
  input,
  password as passwordPrompt,
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

  ask(message: string, defaultValue?: string): Effect.Effect<string, never> {
    return Effect.promise(async () => {
      const answer = await input({
        message,
        ...(defaultValue !== undefined ? { default: defaultValue } : {}),
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

  select(message: string, choices: string[]): Effect.Effect<string, never> {
    return Effect.promise(async () => {
      const answer = await selectPrompt<string>({
        message,
        choices,
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
}

/**
 * Create the terminal service layer
 */
export function createTerminalServiceLayer(): Layer.Layer<TerminalService, never, never> {
  return Layer.succeed(TerminalServiceTag, new TerminalServiceImpl());
}
