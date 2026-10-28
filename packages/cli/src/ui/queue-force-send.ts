import { store } from "./store";

export type ForceSendOutcome = "sent" | "nothing-to-send" | "no-run";

/**
 * Classic-interface Ctrl+Enter: queue the draft and interrupt the run so the chat
 * loop drains the queue now. Returns "no-run" without touching the queue when no
 * interrupt handler is registered, so the caller can treat the key as plain Enter
 * instead of queueing a message that then waits for the run to finish.
 */
export function forceSendQueue(draft: string, interrupt: (() => void) | null): ForceSendOutcome {
  if (interrupt === null) return "no-run";
  if (draft.length > 0) store.appendToQueue(draft);
  if (store.getMessageQueueSnapshot().length === 0) return "nothing-to-send";
  store.requestFlushQueue();
  store.printOutput({ type: "warn", message: "Interrupting…", timestamp: new Date() });
  store.collapseAllEphemeral();
  interrupt();
  return "sent";
}
