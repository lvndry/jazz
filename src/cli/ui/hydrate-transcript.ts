import type { ChatMessage } from "@/core/types/message";
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
}
