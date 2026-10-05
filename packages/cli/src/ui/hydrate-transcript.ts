/**
 * Restores conversation presentation as one atomic document transaction. Saved
 * semantic entries retain source identity and facts; message-only history gets
 * deterministic IDs and source Markdown without replaying terminal output.
 * Model continuation nudges, tool protocol messages, and system prompts are not
 * conversation presentation and never become visible user turns.
 */
import { typedText } from "@jazz/core/memory/source-trust";
import type { ChatMessage } from "@jazz/core/types/message";
import type { PresentationEntry } from "@jazz/core/types/presentation-content";
import { store } from "./store";

export interface TranscriptSink {
  readonly replaceDocument: (id: string, entries: readonly PresentationEntry[]) => void;
}

/** Derive source entries only when a conversation has no saved semantic document. */
export function presentationEntriesFromHistory(
  messages: readonly ChatMessage[],
  documentId: string,
): PresentationEntry[] {
  const entries: PresentationEntry[] = [];
  for (const [index, message] of messages.entries()) {
    if (
      (message.role !== "user" && message.role !== "assistant") ||
      message.kind === "continuation" ||
      message.content.trim().length === 0
    )
      continue;
    entries.push({
      id: `${documentId}:message:${index}`,
      timestamp: new Date(0).toISOString(),
      content:
        message.role === "user"
          ? { kind: "user", text: typedText(message) }
          : { kind: "agent", markdown: message.content },
    });
  }
  return entries;
}

export function hydrateTranscriptFromHistory(
  messages: readonly ChatMessage[],
  documentId: string,
  target: TranscriptSink = store,
): void {
  target.replaceDocument(documentId, presentationEntriesFromHistory(messages, documentId));
}

/**
 * Re-seeds ↑ recall from a chat session's persisted history.
 *
 * Input history lives in the store and is only appended to as the user types,
 * so a resumed conversation would otherwise offer nothing to recall. Replaying
 * the user turns through `pushInputHistory` restores recall as far back as the
 * store's cap allows, newest last. Consecutive duplicates collapse in the
 * store, the same way they do while typing. Kept separate from transcript
 * hydration so a caller injecting a custom sink does not also mutate the
 * global recall state.
 */
export function hydrateInputHistoryFromMessages(
  messages: readonly ChatMessage[],
  target: { pushInputHistory: (message: string) => void; clearInputHistory: () => void } = store,
): void {
  target.clearInputHistory();
  for (const message of messages) {
    if (message.role !== "user" || message.kind === "continuation") continue;
    if (message.content.trim().length === 0) continue;
    target.pushInputHistory(typedText(message));
  }
}

/** Restore UI-only facts without manufacturing model-facing messages or live streams. */
export function hydrateTranscriptFromUiEntries(
  entries: readonly PresentationEntry[],
  documentId: string,
  target: TranscriptSink = store,
): void {
  target.replaceDocument(documentId, entries);
}
