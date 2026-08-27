/**
 * Telegram chat → agent id mapping.
 *
 * Each Telegram chat gets its own Jazz agent JSON (cloned from a seeded
 * template on first contact) so `/model` and `/persona` changes stay scoped to
 * that chat. The agent file format and lifecycle are shared with the Discord
 * bridge via `@jazz/bot-shared/agent-file`; only the id scheme below is
 * Telegram-specific.
 */

import {
  type AgentConfig,
  type AgentFile,
  agentPath,
  ensureScopedAgent,
  readAgentFile,
  syncAgentDisplayName as syncScopedAgentDisplayName,
  writeAgentFile,
} from "@jazz/bot-shared/agent-file";

export type { AgentConfig, AgentFile };
export { agentPath, readAgentFile, writeAgentFile };

export function agentIdForChat(chatId: number): string {
  // Group chat ids are negative; keep the id filename/name-safe.
  return `tg_${String(chatId).replace("-", "n")}`;
}

export function isChatAgentId(agentId: string): boolean {
  return /^tg_n?\d+$/.test(agentId);
}

export function ensureChatAgent(dataDir: string, chatId: number, baseAgentId: string): AgentFile {
  return ensureScopedAgent(dataDir, agentIdForChat(chatId), baseAgentId);
}

/**
 * Point the seed template and every chat agent at the bot's current Telegram
 * name, so the persona's {agentName} matches the name people see in the
 * client. Runs on each start, which also picks up a bot rename.
 */
export function syncAgentDisplayName(
  dataDir: string,
  baseAgentId: string,
  displayName: string,
): void {
  syncScopedAgentDisplayName(dataDir, baseAgentId, displayName, isChatAgentId);
}
