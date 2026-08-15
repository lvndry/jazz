/**
 * Per-channel agent files.
 *
 * Each Discord DM or thread gets its own Jazz agent JSON (cloned from a seeded
 * template on first contact) so `/model` and `/persona` changes stay scoped to
 * that conversation. `dataDir` is Jazz's home; agents live under `<dataDir>/agents`.
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

export function agentIdForChannel(channelId: string): string {
  return `dc_${channelId}`;
}

export function channelIdFromAgentId(agentId: string): string | null {
  if (!agentId.startsWith("dc_")) return null;
  const suffix = agentId.slice("dc_".length);
  return /^\d{17,20}$/.test(suffix) ? suffix : null;
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

export function hasChatAgent(dataDir: string, channelId: string): boolean {
  return existsSync(agentPath(dataDir, agentIdForChannel(channelId)));
}

/** Ensure a channel has its own agent, cloned from the seeded template on first use. */
export function ensureChatAgent(
  dataDir: string,
  channelId: string,
  baseAgentId: string,
): AgentFile {
  const agentId = agentIdForChannel(channelId);
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
