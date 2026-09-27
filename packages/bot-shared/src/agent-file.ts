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

import { existsSync } from "node:fs";
import { join } from "node:path";
import { ensureChatSandbox, listChatSandboxes, sandboxOwnership } from "./chat-sandbox";
import { type Ownership, type PinnedDirectory, withDirectory } from "./sandbox-fs";

export interface AgentConfig {
  llmProvider: string;
  llmModel: string;
  reasoning: string;
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

const AGENTS_DIRECTORY = "agents";

/** A mode for writes the bridge makes into its own data directory. */
const DEFAULT_FILE_MODE = 0o640;
const DEFAULT_DIRECTORY_MODE = 0o750;

export function agentPath(dataDir: string, agentId: string): string {
  return join(dataDir, AGENTS_DIRECTORY, `${agentId}.json`);
}

function agentFileName(agentId: string): string {
  return `${agentId}.json`;
}

/**
 * Run `operation` inside `<dataDir>/agents`, reached without following a link at that name.
 *
 * A conversation home is owned by the conversation's uid, and the bridge writes into it as
 * root, so `agents` and every file in it may be a link the agent planted. `create` makes the
 * directory (replacing anything that is not one) and hands it to `ownership`.
 */
function withAgentsDirectory<T>(
  dataDir: string,
  create: boolean,
  ownership: Ownership | undefined,
  operation: (agents: PinnedDirectory) => T,
): T {
  return withDirectory(dataDir, {}, (home) => {
    const agents = home.directory(
      AGENTS_DIRECTORY,
      create
        ? {
            create: {
              owner: ownership?.owner,
              mode: ownership?.directoryMode ?? DEFAULT_DIRECTORY_MODE,
            },
          }
        : {},
    );
    try {
      return operation(agents);
    } finally {
      agents.close();
    }
  });
}

function parseAgent(agents: PinnedDirectory, agentId: string): AgentFile {
  const raw = agents.readText(agentFileName(agentId));
  if (raw === undefined) {
    throw new Error(`No agent file for ${agentId} in ${agents.path}`);
  }
  return JSON.parse(raw) as AgentFile;
}

function writeAgent(
  agents: PinnedDirectory,
  agent: AgentFile,
  ownership: Ownership | undefined,
): void {
  agent.updatedAt = new Date().toISOString();
  agents.writeBytes(agentFileName(agent.id), `${JSON.stringify(agent, null, 2)}\n`, {
    owner: ownership?.owner,
    mode: ownership?.fileMode ?? DEFAULT_FILE_MODE,
  });
}

export function readAgentFile(dataDir: string, agentId: string): AgentFile {
  return withAgentsDirectory(dataDir, false, undefined, (agents) => parseAgent(agents, agentId));
}

export function writeAgentFile(dataDir: string, agent: AgentFile, ownership?: Ownership): void {
  withAgentsDirectory(dataDir, true, ownership, (agents) => writeAgent(agents, agent, ownership));
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
  return ensureScopedAgentFrom(dataDir, dataDir, agentId, baseAgentId);
}

/**
 * Same, for bridges that keep each conversation's agent somewhere other than
 * the directory holding the seed template — a per-conversation sandbox home,
 * which the entrypoint never writes the template into.
 */
export function ensureScopedAgentFrom(
  templateDir: string,
  targetDir: string,
  agentId: string,
  baseAgentId: string,
  ownership?: Ownership,
): AgentFile {
  return withAgentsDirectory(targetDir, true, ownership, (agents) => {
    if (agents.readText(agentFileName(agentId)) !== undefined) {
      return parseAgent(agents, agentId);
    }
    const template = readAgentFile(templateDir, baseAgentId);
    template.id = agentId;
    writeAgent(agents, template, ownership);
    return template;
  });
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
  ownership?: Ownership,
): void {
  if (!existsSync(join(dataDir, AGENTS_DIRECTORY))) return;
  withAgentsDirectory(dataDir, false, ownership, (agents) => {
    for (const entry of agents.list()) {
      if (!entry.endsWith(".json")) continue;
      const agentId = entry.slice(0, -".json".length);
      if (agentId !== baseAgentId && !isScopedAgentId(agentId)) continue;
      try {
        const agent = parseAgent(agents, agentId);
        if (agent.name === displayName) continue;
        agent.name = displayName;
        writeAgent(agents, agent, ownership);
      } catch (error) {
        console.error(`Could not rename agent ${agentId}: ${String(error)}`);
      }
    }
  });
}

/** Remove one agent file, without following a link at its name. */
export function removeAgentFile(dataDir: string, agentId: string): void {
  if (!existsSync(join(dataDir, AGENTS_DIRECTORY))) return;
  withAgentsDirectory(dataDir, false, undefined, (agents) => agents.remove(agentFileName(agentId)));
}

/**
 * `syncAgentDisplayName` over the shared data directory and every conversation home, each
 * written back to the uid that owns it.
 */
export function syncAgentDisplayNameEverywhere(
  dataDir: string,
  baseAgentId: string,
  displayName: string,
  isScopedAgentId: (agentId: string) => boolean,
): void {
  syncAgentDisplayName(dataDir, baseAgentId, displayName, isScopedAgentId);
  for (const { agentId } of listChatSandboxes(dataDir)) {
    const sandbox = ensureChatSandbox(dataDir, agentId);
    syncAgentDisplayName(
      sandbox.home,
      baseAgentId,
      displayName,
      isScopedAgentId,
      sandboxOwnership(sandbox),
    );
  }
}
