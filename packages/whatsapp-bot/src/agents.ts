/**
 * WhatsApp chat → agent id mapping.
 *
 * A JID (`33123456789@s.whatsapp.net`, `1203…@g.us`) contains `@` and `.`,
 * neither of which belongs in a filename, so the id keeps only the part that
 * identifies the conversation and tags which kind it was. Both directions are
 * needed: reminders arrive holding an agent id and have to be delivered back to
 * a JID, so the encoding has to be reversible rather than merely unique.
 */

import { syncAgentDisplayName as syncScopedAgentDisplayName } from "@jazz/bot-shared/agent-file";
import { listChatSandboxes } from "@jazz/bot-shared/chat-sandbox";
import { isGroupJid, type Jid, normalizeJid } from "./access";

export function agentIdForChat(jid: Jid): string {
  return `${isGroupJid(jid) ? "wag" : "wa"}_${normalizeJid(jid).replace(/[^a-z0-9]/g, "")}`;
}

export function isChatAgentId(agentId: string): boolean {
  return /^wag?_[a-z0-9]+$/.test(agentId);
}

/** Reverse of `agentIdForChat`: rebuild the JID the id was made from. */
export function jidFromAgentId(agentId: string): Jid | undefined {
  if (!isChatAgentId(agentId)) return undefined;
  if (agentId.startsWith("wag_")) return `${agentId.slice("wag_".length)}@g.us`;
  return `${agentId.slice("wa_".length)}@s.whatsapp.net`;
}

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
