import type { ChatMessage } from "@/core/types/message";

/**
 * The deferred-tier tools earlier turns unlocked, in first-unlock order, restricted to the tools
 * this run still offers. Unlock order keeps the declared tools block a stable prefix across
 * requests: each new unlock only appends.
 */
export function collectUnlockedToolNames(
  history: readonly ChatMessage[],
  deferredToolNames: readonly string[],
): readonly string[] {
  const offered = new Set(deferredToolNames);
  const unlocked = new Set<string>();
  for (const message of history) {
    for (const name of message.unlockedToolNames ?? []) {
      if (offered.has(name)) {
        unlocked.add(name);
      }
    }
  }
  return [...unlocked];
}

/** Every unlock the messages record, in first-unlock order, whether or not a tool is still offered. */
export function listUnlockedToolNames(messages: readonly ChatMessage[]): readonly string[] {
  const unlocked = new Set<string>();
  for (const message of messages) {
    for (const name of message.unlockedToolNames ?? []) {
      unlocked.add(name);
    }
  }
  return [...unlocked];
}

/**
 * `kept` with the unlocks of `dropped` carried onto it, for any path that drops history
 * (trimming). The first kept non-system message takes the dropped unlocks ahead of its own, so
 * the order a later run restores them in stays first-unlock order. Returns `kept` unchanged when
 * the dropped messages unlocked nothing or nothing kept can carry them.
 */
export function carryUnlockedToolNames<Messages extends readonly ChatMessage[]>(
  dropped: readonly ChatMessage[],
  kept: Messages,
): Messages {
  const droppedNames = listUnlockedToolNames(dropped);
  const carrierIndex = kept.findIndex((message) => message.role !== "system");
  if (droppedNames.length === 0 || carrierIndex === -1) {
    return kept;
  }
  const carrier = kept[carrierIndex] as ChatMessage;
  const carried = [...kept];
  carried[carrierIndex] = {
    ...carrier,
    unlockedToolNames: [...new Set([...droppedNames, ...(carrier.unlockedToolNames ?? [])])],
  };
  return carried as unknown as Messages;
}
