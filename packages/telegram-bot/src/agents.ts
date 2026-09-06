/**
 * Telegram chat → agent id mapping.
 *
 * Each Telegram chat gets its own Jazz agent JSON (cloned from a seeded
 * template on first contact) so `/model` and `/persona` changes stay scoped to
 * that chat. The agent file format and lifecycle are shared with the Discord
 * bridge via `@jazz/bot-shared/agent-file`; only the id scheme below is
 * Telegram-specific.
 *
 * Where the file lands depends on whether per-chat sandboxes are on: with them
 * the agent belongs to the chat's own Jazz home, so the chat's uid can read and
 * Jazz can rewrite it; without them everything stays in the shared data
 * directory as before. The seed template is only ever in the shared directory —
 * the entrypoint writes it there — so cloning always reads from one place and
 * writes to another.
 */

import {
  type AgentConfig,
  type AgentFile,
  agentPath,
  ensureScopedAgentFrom,
  readAgentFile,
  syncAgentDisplayName as syncScopedAgentDisplayName,
  writeAgentFile,
} from "@jazz/bot-shared/agent-file";
import {
  adoptIntoSandbox,
  type ChatSandbox,
  listChatSandboxes,
} from "@jazz/bot-shared/chat-sandbox";

export type { AgentConfig, AgentFile };
export { agentPath, readAgentFile };

export function agentIdForChat(chatId: number): string {
  // Group chat ids are negative; keep the id filename/name-safe.
  return `tg_${String(chatId).replace("-", "n")}`;
}

export function isChatAgentId(agentId: string): boolean {
  return /^tg_n?\d+$/.test(agentId);
}

export function ensureChatAgent(
  dataDir: string,
  sandbox: ChatSandbox,
  chatId: number,
  baseAgentId: string,
): AgentFile {
  const agent = ensureScopedAgentFrom(dataDir, sandbox.home, agentIdForChat(chatId), baseAgentId);
  adoptIntoSandbox(sandbox, agentPath(sandbox.home, agent.id));
  return agent;
}

/** Write an agent file into a chat's own home, leaving it owned by that chat. */
export function writeChatAgentFile(sandbox: ChatSandbox, agent: AgentFile): void {
  writeAgentFile(sandbox.home, agent);
  adoptIntoSandbox(sandbox, agentPath(sandbox.home, agent.id));
}

/**
 * Point the seed template and every chat agent at the bot's current Telegram
 * name, so the persona's {agentName} matches the name people see in the
 * client. Runs on each start, which also picks up a bot rename.
 *
 * The seed lives in the shared data directory and each chat's agent in its own
 * home, so both places are walked.
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
