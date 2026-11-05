import { isCommandInput } from "@/cli/chat/commands/parser";

/**
 * Where a queued message goes. `steer` reaches the running turn at its next step; `followup`
 * waits for the turn to end and then runs as a turn of its own.
 */
export type QueueLane = "steer" | "followup";

export interface QueueEntry {
  readonly text: string;
  readonly lane: QueueLane;
}

export const EMPTY_QUEUE_ENTRIES: readonly QueueEntry[] = [];

const EMPTY_TEXTS: readonly string[] = [];

/** A single-line slash or shell command, which runs alone and is never sent to the model as prose. */
export function isQueuedCommand(text: string): boolean {
  const trimmed = text.trim();
  return isCommandInput(trimmed) && !trimmed.includes("\n");
}

function isSteering(entry: QueueEntry): boolean {
  return entry.lane === "steer" && !isQueuedCommand(entry.text);
}

function steeringHorizon(queue: readonly QueueEntry[]): number {
  const commandIndex = queue.findIndex((entry) => isQueuedCommand(entry.text));
  return commandIndex === -1 ? queue.length : commandIndex;
}

export interface QueueTake {
  readonly taken: readonly string[];
  readonly rest: readonly QueueEntry[];
}

/**
 * The steering messages a running turn picks up: every `steer` entry ahead of the first command,
 * in order. Follow-ups stay queued where they are, and a command holds back everything behind it.
 */
export function takeSteering(queue: readonly QueueEntry[]): QueueTake {
  const horizon = steeringHorizon(queue);
  const taken: string[] = [];
  const rest: QueueEntry[] = [];
  queue.forEach((entry, index) => {
    if (index < horizon && entry.lane === "steer") {
      taken.push(entry.text);
    } else {
      rest.push(entry);
    }
  });
  if (taken.length === 0) {
    return { taken: EMPTY_TEXTS, rest: queue };
  }
  return { taken, rest };
}

/** Whether a running turn has a steering message waiting. */
export function hasSteering(queue: readonly QueueEntry[]): boolean {
  return queue.slice(0, steeringHorizon(queue)).some(isSteering);
}

/**
 * The next turn once the chat is between turns, in queue order: a command at the head runs
 * alone, a follow-up runs alone, and a run of steering messages is sent as one combined message
 * that ends at the next follow-up or command.
 */
export function takeNextTurn(queue: readonly QueueEntry[]): QueueTake {
  const head = queue[0];
  if (head === undefined) {
    return { taken: EMPTY_TEXTS, rest: queue };
  }
  if (head.lane === "followup" || isQueuedCommand(head.text)) {
    return { taken: [head.text], rest: queue.slice(1) };
  }
  let end = 1;
  while (end < queue.length && isSteering(queue[end]!)) {
    end += 1;
  }
  return { taken: queue.slice(0, end).map((entry) => entry.text), rest: queue.slice(end) };
}

/** Every entry's text joined as the composer shows it when the queue is recalled for editing. */
export function queueText(queue: readonly QueueEntry[]): string {
  return queue.map((entry) => entry.text).join("\n");
}

/** How many entries wait for the turn to end instead of steering it. */
export function followUpCount(queue: readonly QueueEntry[]): number {
  return queue.filter((entry) => entry.lane === "followup").length;
}
