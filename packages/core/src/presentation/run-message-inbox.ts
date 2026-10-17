/**
 * Messages a chat bridge writes into a `jazz run` while it works, delivered at its next step.
 *
 * The bridge writes `{"type":"user_message","id":"…","text":"…"}` on stdin and the run's
 * protocol reader pushes each one here. The agent loop takes everything waiting as one user
 * message before its next model call, and the run reports the ids it took in a
 * `user_message_delivered` event. A message the run never took (it arrived during the final
 * answer) is the bridge's to answer in a turn of its own.
 */

import type { QueuedMessage } from "@/core/agent/types";

interface WaitingMessage {
  readonly id: string;
  readonly text: string;
}

/** What the inbox needs from the stdin protocol reader that fills it. */
export interface RunMessageReader {
  /** Start reading stdin, once. Called on first use, after `--input-stdin` took its frame. */
  readonly startReading: () => void;
  /** Tell the bridge which messages the run has taken. */
  readonly reportDelivered: (ids: readonly string[]) => void;
}

export class RunMessageInbox {
  private readonly waiting: WaitingMessage[] = [];
  private readonly listeners = new Set<() => void>();
  private reader: RunMessageReader | undefined;

  connect(reader: RunMessageReader): void {
    this.reader = reader;
  }

  push(id: string, text: string): void {
    this.waiting.push({ id, text });
    for (const listener of [...this.listeners]) {
      this.listeners.delete(listener);
      listener();
    }
  }

  /** Everything waiting, as one message in the order it arrived; `undefined` when nothing is. */
  take(): QueuedMessage | undefined {
    this.reader?.startReading();
    if (this.waiting.length === 0) {
      return undefined;
    }
    const delivered = this.waiting.splice(0);
    this.reader?.reportDelivered(delivered.map((message) => message.id));
    const typed = delivered.map((message) => message.text).join("\n");
    return { content: typed, typed };
  }

  /** Calls `listener` once a message is waiting, at once when one already is; returns a cancel. */
  onceWaiting(listener: () => void): () => void {
    this.reader?.startReading();
    if (this.waiting.length > 0) {
      listener();
      return () => {};
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
