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
