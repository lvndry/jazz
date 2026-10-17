/**
 * Plain terminal port for unattended and print-and-exit runs.
 *
 * Kept free of Ink and React so `jazz run --no-tui`, quiet output and scheduled
 * workflows never load the interactive UI stack.
 */

import {
  isTerminalReport,
  TerminalServiceTag,
  type TerminalOutput,
  type TerminalService,
} from "@jazz/core/interfaces/terminal";
import { Effect, Layer } from "effect";
import { createLineSource, type LineSource } from "@/cli/stdin-lines";
import { getGlyphs } from "@/cli/ui/glyphs";
import { reportPlainText } from "@/cli/ui/report-layout";

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
