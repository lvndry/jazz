/**
 * Replays a chat session's persisted message history into the scrollback
 * store, so resuming a conversation shows prior turns instead of starting
 * from a blank transcript.
 */

import type { ConversationUiEntry } from "@jazz/adapters/history/conversation-history-service";
import type { ChatMessage } from "@jazz/core/types/message";
import { store } from "./store";
import type { OutputEntry } from "./types";

export interface TranscriptSink {
  readonly clearOutputs: () => void;
  readonly printOutput: (entry: OutputEntry) => string;
  readonly flushOutputBatchNow: () => void;
}

export function outputEntriesFromHistory(messages: readonly ChatMessage[]): OutputEntry[] {
  const entries: OutputEntry[] = [];
  const timestamp = new Date();

  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }
    // Compaction's "continue the task" nudge is addressed to the model. Painted as a
    // user turn, it reads as something the user typed.
    if (message.kind === "continuation") {
      continue;
    }
    if (message.content.trim().length === 0) {
      continue;
    }
    entries.push({
      type: message.role === "user" ? "user" : "streamContent",
      message: message.content,
      timestamp,
    });
  }

  return entries;
}

export function hydrateTranscriptFromHistory(
  messages: readonly ChatMessage[],
  target: TranscriptSink = store,
): void {
  target.clearOutputs();
  for (const entry of outputEntriesFromHistory(messages)) {
    target.printOutput(entry);
  }
  target.flushOutputBatchNow();
  hydrateInputHistoryFromMessages(messages);
}

/**
 * Re-seeds ↑ recall from a chat session's persisted history.
 *
 * Input history lives in the store and is only appended to as the user types,
 * so a resumed conversation would offer nothing to recall. Replaying the user
 * turns through `pushInputHistory` restores recall as far back as the store's
 * cap allows, newest last. Consecutive duplicates collapse in the store, the
 * same way they do while typing.
 */
export function hydrateInputHistoryFromMessages(
  messages: readonly ChatMessage[],
  target: { pushInputHistory: (message: string) => void; clearInputHistory: () => void } = store,
): void {
  target.clearInputHistory();
  for (const message of messages) {
    if (message.role !== "user" || message.kind === "continuation") continue;
    if (message.content.trim().length === 0) continue;
    target.pushInputHistory(message.content);
  }
}

/** Restore UI-only command output without feeding it back into the model. */
export function hydrateTranscriptFromUiEntries(
  entries: readonly ConversationUiEntry[],
  target: TranscriptSink = store,
): void {
  target.clearOutputs();
  for (const entry of entries) {
    target.printOutput({ ...entry, timestamp: new Date() });
  }
  target.flushOutputBatchNow();
}
