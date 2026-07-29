/**
 * Per-chat agent files.
 *
 * Each Telegram chat gets its own Jazz agent JSON (cloned from a seeded
 * template on first contact) so `/model` and `/persona` changes stay scoped to
 * that chat. `dataDir` is Jazz's home; agents live under `<dataDir>/agents`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  template.name = agentId;
  writeAgentFile(dataDir, template);
  return template;
}
