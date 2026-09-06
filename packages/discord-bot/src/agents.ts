/**
 * Discord channel/thread → agent id mapping.
 *
 * Each Discord DM or thread gets its own Jazz agent JSON (cloned from a seeded
 * template on first contact) so `/model` and `/persona` changes stay scoped to
 * that conversation. The agent file format and lifecycle are shared with the
 * Telegram bridge via `@jazz/bot-shared/agent-file`; only the id scheme below
 * is Discord-specific.
 *
 * Where the file lands depends on whether per-conversation sandboxes are on:
 * with them the agent belongs to the conversation's own Jazz home, so its uid
 * can read it and Jazz can rewrite it; without them everything stays in the
 * shared data directory as before. The seed template is only ever in the shared
 * directory — the entrypoint writes it there — so cloning always reads from one
 * place and writes to another.
 */

import {
  type AgentConfig,
  type AgentFile,
  agentPath,
  ensureScopedAgentFrom,
  hasAgentFile,
  readAgentFile,
  syncAgentDisplayName as syncScopedAgentDisplayName,
  writeAgentFile,
} from "@jazz/bot-shared/agent-file";
import {
  adoptIntoSandbox,
  type ChatSandbox,
  chatHome,
  listChatSandboxes,
} from "@jazz/bot-shared/chat-sandbox";

export type { AgentConfig, AgentFile };
export { agentPath, readAgentFile };

export function agentIdForChannel(channelId: string): string {
  return `dc_${channelId}`;
}

export function channelIdFromAgentId(agentId: string): string | null {
  if (!agentId.startsWith("dc_")) return null;
  const suffix = agentId.slice("dc_".length);
  return /^\d{17,20}$/.test(suffix) ? suffix : null;
}

/**
 * Whether this channel has been talked to before.
 *
 * Deliberately resolves the home as a path rather than provisioning a sandbox:
 * this is called while deciding whether a message is even allowed, and minting
 * a uid for every channel id that shows up would hand an unauthorized caller a
 * way to fill the account table.
 */
export function hasChatAgent(dataDir: string, channelId: string): boolean {
  const agentId = agentIdForChannel(channelId);
  return hasAgentFile(chatHome(dataDir, agentId), agentId);
}

export function ensureChatAgent(
  dataDir: string,
  sandbox: ChatSandbox,
  channelId: string,
  baseAgentId: string,
): AgentFile {
  const agent = ensureScopedAgentFrom(
    dataDir,
    sandbox.home,
    agentIdForChannel(channelId),
    baseAgentId,
  );
  adoptIntoSandbox(sandbox, agentPath(sandbox.home, agent.id));
  return agent;
}

/** Write an agent file into a conversation's own home, leaving it owned by that conversation. */
export function writeChatAgentFile(sandbox: ChatSandbox, agent: AgentFile): void {
  writeAgentFile(sandbox.home, agent);
  adoptIntoSandbox(sandbox, agentPath(sandbox.home, agent.id));
}

/**
 * Point the seed template and every conversation agent at the bot's current
 * Discord username, so the persona's {agentName} matches the name people see
 * in the client. Runs on each READY, which also picks up a bot rename.
 *
 * The seed lives in the shared data directory and each conversation's agent in
 * its own home, so both places are walked.
 */
export function syncAgentDisplayName(
  dataDir: string,
  baseAgentId: string,
  displayName: string,
): void {
  const isConversationAgent = (agentId: string): boolean => channelIdFromAgentId(agentId) !== null;
  syncScopedAgentDisplayName(dataDir, baseAgentId, displayName, isConversationAgent);
  for (const { home } of listChatSandboxes(dataDir)) {
    syncScopedAgentDisplayName(home, baseAgentId, displayName, isConversationAgent);
  }
}
