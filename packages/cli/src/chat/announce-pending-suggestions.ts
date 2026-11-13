/**
 * Chat notification for queued memory proposals. Call at chat opening to show the backlog,
 * then after each turn with its previous count to remind at ten-item milestones.
 */
import { MemoryServiceTag } from "@jazz/core/interfaces/memory-service";
import { TerminalServiceTag } from "@jazz/core/interfaces/terminal";
import { Effect } from "effect";

/**
 * Say how many memory suggestions wait for review. Background passes queue them before a
 * compaction and after a conversation closes. A chat opening shows the current count; later
 * turns remind the person when the backlog crosses another multiple of ten.
 */
export function announcePendingSuggestions(options: { readonly onlyIfMoreThan?: number } = {}) {
  return Effect.gen(function* () {
    const memoryService = yield* MemoryServiceTag;
    const terminal = yield* TerminalServiceTag;
    const suggestions = yield* memoryService.pendingSuggestions();
    const count = suggestions.length;
    const priorCount = options.onlyIfMoreThan;
    if (
      count === 0 ||
      (priorCount !== undefined && Math.floor(count / 10) <= Math.floor(priorCount / 10))
    ) {
      return count;
    }
    yield* terminal.info(
      `${count === 1 ? "1 memory suggestion waits" : `${String(count)} memory suggestions wait`} for review: /memory review`,
    );
    return count;
  });
}
