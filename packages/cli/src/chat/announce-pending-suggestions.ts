import { MemoryServiceTag } from "@jazz/core/interfaces/memory-service";
import { TerminalServiceTag } from "@jazz/core/interfaces/terminal";
import { Effect } from "effect";

/**
 * Say how many memory suggestions wait for review. Background passes queue them before a
 * compaction and after a conversation closes, so a person hears of them at the next chat
 * opening and at the end of the turn that queued them.
 */
export function announcePendingSuggestions(options: { readonly onlyIfMoreThan?: number } = {}) {
  return Effect.gen(function* () {
    const memoryService = yield* MemoryServiceTag;
    const terminal = yield* TerminalServiceTag;
    const suggestions = yield* memoryService.pendingSuggestions();
    if (suggestions.length === 0 || suggestions.length <= (options.onlyIfMoreThan ?? 0)) {
      return suggestions.length;
    }
    yield* terminal.info(
      `${suggestions.length === 1 ? "1 memory suggestion waits" : `${String(suggestions.length)} memory suggestions wait`} for review: /memory review`,
    );
    return suggestions.length;
  });
}
