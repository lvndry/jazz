/**
 * Discord channel/thread → agent id mapping.
 *
 * Each Discord DM or thread gets its own Jazz agent JSON (cloned from a seeded
 * template on first contact) so `/model` and `/persona` changes stay scoped to
 * that conversation. The agent file format and lifecycle are shared with the
 * Telegram bridge via `@jazz/bot-shared/agent-file`; only the id scheme below
 * is Discord-specific.
 */

import {
  type AgentConfig,
  type AgentFile,
  agentPath,
  ensureScopedAgent,
  hasAgentFile,
  readAgentFile,
  syncAgentDisplayName as syncScopedAgentDisplayName,
  writeAgentFile,
} from "@jazz/bot-shared/agent-file";

export type { AgentConfig, AgentFile };
export { agentPath, readAgentFile, writeAgentFile };

export function agentIdForChannel(channelId: string): string {
  return `dc_${channelId}`;
}

export function channelIdFromAgentId(agentId: string): string | null {
  if (!agentId.startsWith("dc_")) return null;
  const suffix = agentId.slice("dc_".length);
  return /^\d{17,20}$/.test(suffix) ? suffix : null;
}

export function hasChatAgent(dataDir: string, channelId: string): boolean {
  return hasAgentFile(dataDir, agentIdForChannel(channelId));
}

export function ensureChatAgent(
  dataDir: string,
  channelId: string,
  baseAgentId: string,
): AgentFile {
  return ensureScopedAgent(dataDir, agentIdForChannel(channelId), baseAgentId);
}

/**
 * Point the seed template and every conversation agent at the bot's current
 * Discord username, so the persona's {agentName} matches the name people see
 * in the client. Runs on each READY, which also picks up a bot rename.
 */
export function syncAgentDisplayName(
  dataDir: string,
  baseAgentId: string,
  displayName: string,
): void {
  syncScopedAgentDisplayName(
    dataDir,
    baseAgentId,
    displayName,
    (agentId) => channelIdFromAgentId(agentId) !== null,
  );
}
