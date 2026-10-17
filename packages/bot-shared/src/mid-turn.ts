/**
 * What happens to a message that arrives while its conversation is mid-turn.
 *
 * The person who started the run is usually adding to their request ("for 4 people",
 * "actually make it Friday"), so their plain messages go into the running turn, which reads
 * them before its next model call. Everything else waits in the queue: a command acts on the
 * conversation rather than the request, and another person's message would steer a run whose
 * approvals belong to the requester. Queued plain messages from one sender are answered as one
 * turn, not one turn each.
 */

import type { InboundMessage, SenderId } from "./turn";

export type BusyRoute = "into-run" | "queue";

export function routeBusyMessage(input: {
  readonly runInFlight: boolean;
  readonly requester: SenderId | undefined;
  readonly senderId: SenderId;
  readonly isCommand: boolean;
}): BusyRoute {
  return input.runInFlight && !input.isCommand && input.requester === input.senderId
    ? "into-run"
    : "queue";
}

/**
 * Take the next turn off the queue: a command on its own, else the first message joined with
 * every plain message its sender sent right after it.
 */
export function takeNextTurn(
  queue: InboundMessage[],
  isCommand: (text: string) => boolean,
): InboundMessage | undefined {
  const first = queue[0];
  if (first === undefined) {
    return undefined;
  }
  if (isCommand(first.text)) {
    return queue.shift();
  }
  let count = 1;
  while (count < queue.length) {
    const candidate = queue[count];
    if (
      candidate === undefined ||
      candidate.senderId !== first.senderId ||
      isCommand(candidate.text)
    ) {
      break;
    }
    count += 1;
  }
  const group = queue.splice(0, count);
  if (group.length === 1) {
    return first;
  }
  const last = group[group.length - 1] ?? first;
  return {
    chatId: first.chatId,
    senderId: first.senderId,
    text: group.map((message) => message.text).join("\n"),
    replyTo: first.replyTo,
    privateChat: last.privateChat,
    ref: last.ref,
  };
}
