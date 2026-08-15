/**
 * Per-chat agent files.
 *
 * Each Telegram chat gets its own Jazz agent JSON (cloned from a seeded
 * template on first contact) so `/model` and `/persona` changes stay scoped to
 * that chat. `dataDir` is Jazz's home; agents live under `<dataDir>/agents`.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface AgentConfig {
  llmProvider: string;
  llmModel: string;
  reasoningEffort: string;
  persona: string;
  [key: string]: unknown;
}

export interface AgentFile {
  id: string;
  name: string;
  model: string;
  config: AgentConfig;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export function agentIdForChat(chatId: number): string {
  // Group chat ids are negative; keep the id filename/name-safe.
  return `tg_${String(chatId).replace("-", "n")}`;
}

export function isChatAgentId(agentId: string): boolean {
  return /^tg_n?\d+$/.test(agentId);
}

export function agentPath(dataDir: string, agentId: string): string {
  return join(dataDir, "agents", `${agentId}.json`);
}

export function readAgentFile(dataDir: string, agentId: string): AgentFile {
  return JSON.parse(readFileSync(agentPath(dataDir, agentId), "utf8")) as AgentFile;
}

export function writeAgentFile(dataDir: string, agent: AgentFile): void {
  agent.updatedAt = new Date().toISOString();
  writeFileSync(agentPath(dataDir, agent.id), `${JSON.stringify(agent, null, 2)}\n`);
}

/** Ensure a chat has its own agent, cloned from the seeded template on first use. */
export function ensureChatAgent(dataDir: string, chatId: number, baseAgentId: string): AgentFile {
  const agentId = agentIdForChat(chatId);
  const path = agentPath(dataDir, agentId);
  if (existsSync(path)) {
    return readAgentFile(dataDir, agentId);
  }
  mkdirSync(join(dataDir, "agents"), { recursive: true });
  const template = readAgentFile(dataDir, baseAgentId);
  template.id = agentId;
  writeAgentFile(dataDir, template);
  return template;
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
  const directory = join(dataDir, "agents");
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory)) {
    if (!entry.endsWith(".json")) continue;
    const agentId = entry.slice(0, -".json".length);
    if (agentId !== baseAgentId && !isChatAgentId(agentId)) continue;
    try {
      const agent = readAgentFile(dataDir, agentId);
      if (agent.name === displayName) continue;
      agent.name = displayName;
      writeAgentFile(dataDir, agent);
    } catch (error) {
      console.error(`Could not rename agent ${agentId}: ${String(error)}`);
    }
  }
}
