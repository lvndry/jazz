import { MemoryServiceTag } from "@jazz/core/interfaces/memory-service";
import { TerminalServiceTag } from "@jazz/core/interfaces/terminal";
import { Effect } from "effect";

/**
 * On opening a chat, say how many lessons wait for review. Lessons from a closed conversation
 * are proposed in the background after it ends, so the next chat is where the person first
 * hears of them.
 */
export function announcePendingLessons() {
  return Effect.gen(function* () {
    const memoryService = yield* MemoryServiceTag;
    const terminal = yield* TerminalServiceTag;
    const proposals = yield* memoryService.pendingLessons();
    if (proposals.length === 0) {
      return;
    }
    yield* terminal.info(
      `${proposals.length === 1 ? "1 lesson" : `${String(proposals.length)} lessons`} from earlier conversations ${proposals.length === 1 ? "waits" : "wait"} for review: /memory review`,
    );
  });
}
