/**
 * Telling a message that starts with a file path apart from a slash command.
 *
 * Dragging a file into the terminal inserts its absolute path, so
 * "/Users/me/shot.png what is this?" is a question about a screenshot, not a
 * command named "Users". The parser asks `startsWithPath` before it reports an
 * unknown command, and sends such a message to the agent as prose.
 */

import { existsSync } from "node:fs";

/**
 * Whether the first word of a `/`-prefixed message is a path: it has another
 * `/` in it (`/Users/me/shot.png`, `/tmp/`), or names something that exists on
 * disk (`/tmp`). Call it only for words that are not registered commands.
 *
 * @param firstWord - The first whitespace-separated word, including its leading `/`.
 * @param pathExists - Checks the disk; injectable for tests.
 */
export function startsWithPath(
  firstWord: string,
  pathExists: (path: string) => boolean = existsSync,
): boolean {
  if (!firstWord.startsWith("/") || firstWord.length < 2) {
    return false;
  }
  if (firstWord.slice(1).includes("/")) {
    return true;
  }
  return pathExists(firstWord);
}
