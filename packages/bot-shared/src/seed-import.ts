/**
 * @fileoverview Seeding the bridge from an agent you already have.
 *
 * Copied into the bridge's home, never read in place: a bridge renames its seed
 * to the chat's display name, which would rename your real agent.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getJazzHomeDirectory } from "@jazz/core/utils/paths";
import { resolveStorageDirectory } from "@jazz/core/utils/storage";
import { agentPath, readAgentFile } from "./agent-file";

/**
 * Where your agents actually live.
 *
 * Not always the Jazz home: `storage.path` in config.json moves the whole store,
 * and only the global config may — a project-local one is stripped of it.
 */
export function agentStoreDirectory(): string {
  const override = process.env["JAZZ_CONFIG_PATH"]?.trim();
  const configPath =
    override !== undefined && override.length > 0
      ? override.replace(/^~(?=$|\/)/, homedir())
      : join(getJazzHomeDirectory(), "config.json");

  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    const { storage } = parsed as { storage?: Parameters<typeof resolveStorageDirectory>[0] };
    if (storage !== undefined) return resolveStorageDirectory(storage);
  } catch {
    // No config, or unreadable: the store is the Jazz home.
  }
  return getJazzHomeDirectory();
}

export interface AgentSummary {
  readonly id: string;
  readonly name: string;
}

/** Every agent in a Jazz home. A home without one is empty, not an error. */
export function listAgents(dataDir: string): readonly AgentSummary[] {
  let entries: readonly string[];
  try {
    entries = readdirSync(join(dataDir, "agents"));
  } catch {
    return [];
  }

  const agents: AgentSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const id = entry.slice(0, -".json".length);
    try {
      agents.push({ id, name: readAgentFile(dataDir, id).name });
    } catch {
      // Unparseable file: not an agent anyone can be offered.
    }
  }
  return agents;
}

export type AgentMatch =
  | { readonly kind: "found"; readonly id: string }
  | { readonly kind: "missing" }
  | { readonly kind: "ambiguous"; readonly matches: readonly AgentSummary[] };

/** Resolve `--agent` to one id. Ids win over names, which are not unique. */
export function matchAgent(agents: readonly AgentSummary[], query: string): AgentMatch {
  const wanted = query.trim();
  if (wanted.length === 0) return { kind: "missing" };

  const byId = agents.find((agent) => agent.id === wanted);
  if (byId !== undefined) return { kind: "found", id: byId.id };

  const byName = agents.filter((agent) => agent.name.toLowerCase() === wanted.toLowerCase());
  const only = byName[0];
  if (only !== undefined && byName.length === 1) return { kind: "found", id: only.id };
  if (byName.length > 1) return { kind: "ambiguous", matches: byName };
  return { kind: "missing" };
}

/**
 * Copy an agent in to seed from. Returns whether it copied.
 *
 * Never overwrites: after the first run that file holds the model and persona
 * chosen from a phone.
 */
export function importSeedAgent(sourceDir: string, targetDir: string, agentId: string): boolean {
  const source = agentPath(sourceDir, agentId);
  const target = agentPath(targetDir, agentId);
  if (source === target) return false;
  if (!existsSync(source) || existsSync(target)) return false;

  mkdirSync(join(targetDir, "agents"), { recursive: true });
  copyFileSync(source, target);
  return true;
}
