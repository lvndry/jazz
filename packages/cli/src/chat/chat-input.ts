/**
 * What the chat loop does with one prompt result.
 *
 * `classifyChatInput` turns the raw answer from `terminal.ask("You:")` into a
 * decision. The one that matters most is `end-of-input`: a non-interactive
 * terminal resolves `undefined` once stdin has no more lines, and the loop
 * must end there. Treating it as a blank line would prompt again, get
 * `undefined` again at once, and spin. Only `/exit` and its alias `/quit` end
 * the chat; a bare `exit` or `quit` is a message like any other.
 */

import { isExitCommand } from "./commands/constants";

export type ChatInput =
  | { readonly kind: "exit" }
  | { readonly kind: "end-of-input" }
  | { readonly kind: "blank" }
  | { readonly kind: "message"; readonly text: string };

/**
 * Classify one answer from the chat prompt.
 *
 * @param answer - What `ask` resolved with.
 * @param terminalIsInteractive - Whether the terminal waits for a person. Only a
 *   non-interactive terminal uses `undefined` to say stdin has ended.
 */
export function classifyChatInput(
  answer: string | undefined,
  terminalIsInteractive: boolean,
): ChatInput {
  if (answer === undefined && !terminalIsInteractive) {
    return { kind: "end-of-input" };
  }
  const trimmed = (answer ?? "").trim();
  if (isExitCommand(trimmed)) {
    return { kind: "exit" };
  }
  if (answer === undefined || trimmed.length === 0) {
    return { kind: "blank" };
  }
  return { kind: "message", text: answer };
}
