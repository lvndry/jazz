/**
 * @fileoverview Asking the operator a question, when there is one to ask.
 *
 * One interface for the process, created on first use. Reading stdin with
 * `for await (const chunk of process.stdin)` works exactly once: the iterator
 * takes the stream, so a second question never resolves and setup hangs after
 * the first answer.
 */

import { createInterface, type Interface } from "node:readline/promises";

let readline: Interface | undefined;

/** Read one line from stdin. Resolves empty when the stream ends first. */
export async function promptLine(question: string): Promise<string> {
  readline ??= createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await readline.question(`${question} `)).trim();
  } catch {
    // Closed stream: the caller decides whether no answer is fatal.
    return "";
  }
}

/** Let the process exit once nothing else is going to be asked. */
export function closePrompt(): void {
  readline?.close();
  readline = undefined;
}
