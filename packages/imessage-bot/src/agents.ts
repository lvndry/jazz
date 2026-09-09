/**
 * iMessage chat → agent id mapping.
 *
 * Each chat gets its own Jazz agent JSON, cloned from a seeded template on
 * first contact, so a model or persona change stays scoped to that
 * conversation. Creating and rewriting those files is the shared turn runner's
 * job; the id scheme is the only part iMessage owns.
 *
 * The id is keyed on the `chat.db` rowid rather than the chat's GUID: the rowid
 * is what `imsg send --chat-id` addresses, it is already a filename-safe
 * integer, and a GUID contains characters (`;`, `+`) that would have to be
 * escaped into something no longer reversible.
 */

import { syncAgentDisplayName as syncScopedAgentDisplayName } from "@jazz/bot-shared/agent-file";
import { listChatSandboxes } from "@jazz/bot-shared/chat-sandbox";

export function agentIdForChat(chatId: number): string {
  return `im_${String(chatId)}`;
}

export function isChatAgentId(agentId: string): boolean {
  return /^im_\d+$/.test(agentId);
}

/** Reverse of `agentIdForChat`, for anything holding an agent id and needing the chat. */
export function chatIdFromAgentId(agentId: string): number | undefined {
  if (!isChatAgentId(agentId)) return undefined;
  const chatId = Number.parseInt(agentId.slice("im_".length), 10);
  return Number.isFinite(chatId) ? chatId : undefined;
}

/**
 * Point the seed template and every chat agent at the name the person sees in
 * Messages, so a persona's `{agentName}` matches it.
 */
export function syncAgentDisplayName(
  dataDir: string,
  baseAgentId: string,
  displayName: string,
): void {
  syncScopedAgentDisplayName(dataDir, baseAgentId, displayName, isChatAgentId);
  for (const { home } of listChatSandboxes(dataDir)) {
    syncScopedAgentDisplayName(home, baseAgentId, displayName, isChatAgentId);
  }
}
