/**
 * @fileoverview The template agent every conversation's agent is cloned from.
 *
 * The containerised bridges get this from their entrypoint script, which writes
 * the file into the data directory before the bridge starts. A bridge that runs
 * natively — iMessage has to, since it only exists on a Mac — has no entrypoint,
 * so the first message would fail reading a template nobody wrote.
 *
 * Seeding it here instead means a native bridge is runnable with no setup step:
 * point it at a data directory and it makes what it needs.
 */

import { existsSync, mkdirSync } from "node:fs";
import { agentPath, type AgentFile, writeAgentFile } from "./agent-file";

/**
 * What a bridged agent can do out of the box.
 *
 * An everyday assistant reachable from a phone: read and write files, run
 * commands, search the web, set reminders, and build a small page. Identical
 * across bridges on purpose — which tools exist is a product decision, not a
 * per-surface one, and the container templates already agreed on this list.
 */
export const DEFAULT_BRIDGE_TOOLS: readonly string[] = [
  "cd",
  "cp",
  "edit_file",
  "find",
  "grep",
  "ls",
  "mkdir",
  "mv",
  "pwd",
  "read_file",
  "read_pdf",
  "rm",
  "stat",
  "write_file",
  "execute_command",
  "web_search",
  "http_request",
  "add_reminder",
  "list_reminders",
  "cancel_reminder",
  "create_web_app",
];

export interface SeedAgentSpec {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly provider: string;
  readonly model: string;
  /**
   * Keep in step with the model: reasoning-capable models take low|medium|high,
   * and models without it reject anything but "disable".
   */
  readonly reasoningEffort: string;
  readonly persona?: string;
  readonly tools?: readonly string[];
}

/**
 * Write the template agent if it is not already there.
 *
 * Never overwrites: after the first run this file is the operator's, and a
 * restart that reset their model back to the default would be a bridge undoing
 * a choice they made.
 *
 * Returns whether it created one, so a bridge can say so on first start.
 */
export function ensureSeedAgent(dataDir: string, spec: SeedAgentSpec): boolean {
  if (existsSync(agentPath(dataDir, spec.id))) return false;

  mkdirSync(`${dataDir}/agents`, { recursive: true });
  const agent: AgentFile = {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    config: {
      agentType: "default",
      llmProvider: spec.provider,
      llmModel: spec.model,
      reasoningEffort: spec.reasoningEffort,
      persona: spec.persona ?? "default",
      tools: [...(spec.tools ?? DEFAULT_BRIDGE_TOOLS)],
    },
    createdAt: new Date().toISOString(),
  };
  writeAgentFile(dataDir, agent);
  return true;
}
