/**
 * Ctrl+B-detached tool calls that finished, waiting to reach the agent. They are kept apart from
 * the user's message queue: the queue is what the person typed, shown under the composer for
 * them to recall and edit, while these are host messages the agent has to read and the person
 * never wrote. A running turn picks them up at its next step; an idle chat starts a turn with
 * them, the way a finished sub-agent does.
 */
import type { DetachedCallEntry } from "@jazz/core/agent/detach/auto-detach";
import { detachedResultMessage } from "@jazz/core/agent/execution/egress-taint";
import type { DetachedToolResult } from "@jazz/core/agent/types";
import type { ChatMessage } from "@jazz/core/types/message";

export interface DetachedResultInbox {
  readonly push: (result: DetachedToolResult) => void;
  /** Everything waiting, oldest first; empties the inbox. */
  readonly take: () => readonly DetachedToolResult[];
  /** Calls `listener` once a result is waiting, at once when one already is; returns a cancel. */
  readonly once: (listener: () => void) => () => void;
}

export function createDetachedResultInbox(): DetachedResultInbox {
  let pending: DetachedToolResult[] = [];
  const listeners = new Set<() => void>();
  return {
    push: (result) => {
      pending.push(result);
      const waiting = [...listeners];
      listeners.clear();
      for (const listener of waiting) {
        listener();
      }
    },
    take: () => {
      const taken = pending;
      pending = [];
      return taken;
    },
    once: (listener) => {
      if (pending.length > 0) {
        listener();
        return () => {};
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The message the agent reads: each result under the heading that marks it as host-sent. */
export function detachedResultsMessage(results: readonly DetachedToolResult[]): string {
  return results.map((result) => detachedResultMessage(result.summary)).join("\n\n");
}

/** The transcript line the person sees in place of the raw result the agent reads. */
export function detachedResultsNotice(results: readonly DetachedToolResult[]): string {
  const names = results.map((result) => `\`${result.toolName}\``).join(", ");
  return `${names} finished in the background.`;
}

/**
 * A push into the session-wide inbox that only lands while `owner` is still the open
 * conversation. A background command stopped as its conversation is left reports "stopped" from
 * a watcher that runs after the switch; without this check that notice would reach, and wake,
 * the conversation the person moved to.
 */
export function pushWhileOpen(
  inbox: DetachedResultInbox,
  owner: string,
  openConversationId: () => string,
  onDropped: (result: DetachedToolResult) => void,
): (result: DetachedToolResult) => void {
  return (result) => {
    if (openConversationId() !== owner) {
      onDropped(result);
      return;
    }
    inbox.push(result);
  };
}

/**
 * The host message that closes a conversation's history when its running background commands
 * are stopped as it is left, so the saved transcript never ends on a "still running" placeholder.
 */
export function stoppedDetachedMessage(entries: readonly DetachedCallEntry[]): ChatMessage {
  const content = entries
    .map((entry) =>
      detachedResultMessage(
        `Background task \`${entry.toolName}\` (${entry.description}) was stopped before it finished because this conversation was left.`,
      ),
    )
    .join("\n\n");
  return { role: "user", content };
}
