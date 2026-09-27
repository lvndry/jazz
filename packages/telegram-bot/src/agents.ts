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
  readAgentFile,
  syncAgentDisplayNameEverywhere,
} from "@jazz/bot-shared/agent-file";

export type { AgentConfig, AgentFile };
export { agentPath, readAgentFile };

export function agentIdForChat(chatId: number): string {
  // Group chat ids are negative; keep the id filename/name-safe.
  return `tg_${String(chatId).replace("-", "n")}`;
}

export function isChatAgentId(agentId: string): boolean {
  return /^tg_n?\d+$/.test(agentId);
}

/** `tg_<chatId>` with negative ids encoded as `n<abs>`: the reverse of `agentIdForChat`. */
export function chatIdFromAgentId(agentId: string): number | undefined {
  if (!isChatAgentId(agentId)) return undefined;
  const suffix = agentId.slice("tg_".length);
  const numeric = suffix.startsWith("n") ? `-${suffix.slice(1)}` : suffix;
  const chatId = Number.parseInt(numeric, 10);
  return Number.isFinite(chatId) ? chatId : undefined;
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
  syncAgentDisplayNameEverywhere(dataDir, baseAgentId, displayName, isChatAgentId);
}
