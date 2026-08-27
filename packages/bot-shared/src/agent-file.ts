/**
 * Per-conversation agent files, shared shape for the Discord and Telegram bridges.
 *
 * Each bridge gives every conversation (a Discord channel/thread, a Telegram
 * chat) its own Jazz agent JSON, cloned from a seeded template on first
 * contact, so `/model` and `/persona` changes stay scoped to that
 * conversation. `dataDir` is Jazz's home; agents live under `<dataDir>/agents`.
 *
 * The id scheme itself (how a channel/chat id maps to an agent id) is
 * platform-specific and stays in each bridge's own `agents.ts`, since the two
 * platforms use incompatible id shapes (`dc_<snowflake>` vs `tg_<chat id>`)
 * that must never collide.
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
  config: AgentConfig;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
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

export function hasAgentFile(dataDir: string, agentId: string): boolean {
  return existsSync(agentPath(dataDir, agentId));
}

/** Ensure a conversation has its own agent, cloned from the seeded template on first use. */
export function ensureScopedAgent(
  dataDir: string,
  agentId: string,
  baseAgentId: string,
): AgentFile {
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
 * Point the seed template and every conversation agent at the bot's current
 * display name, so the persona's {agentName} matches the name people see in
 * the client. Runs on each start/READY, which also picks up a bot rename.
 *
 * `isScopedAgentId` distinguishes this platform's conversation agents (and
 * any of its other helper agents, e.g. `dc_suggest`) from the seed itself.
 */
export function syncAgentDisplayName(
  dataDir: string,
  baseAgentId: string,
  displayName: string,
  isScopedAgentId: (agentId: string) => boolean,
): void {
  const directory = join(dataDir, "agents");
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory)) {
    if (!entry.endsWith(".json")) continue;
    const agentId = entry.slice(0, -".json".length);
    if (agentId !== baseAgentId && !isScopedAgentId(agentId)) continue;
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
