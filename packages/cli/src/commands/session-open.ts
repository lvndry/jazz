import os from "node:os";
import type { Agent } from "@jazz/core/types/index";
import { agentModelString } from "@jazz/core/utils/provider-model";
import { formatReasoningSelection } from "@/cli/helpers/reasoning";

/**
 * The one line a chat session opens with: who, on which model, how hard it
 * thinks, and where — `sol · openai/gpt-5.6 · reasoning medium · ~/github/jazz`.
 * Keys and commands live in the footer and in /help, not in the transcript.
 */
export function sessionOpenLine(
  agent: Pick<Agent, "name" | "config">,
  workingDirectory: string = process.cwd(),
  homeDirectory: string = os.homedir(),
): string {
  const directory =
    workingDirectory === homeDirectory || workingDirectory.startsWith(`${homeDirectory}/`)
      ? `~${workingDirectory.slice(homeDirectory.length)}`
      : workingDirectory;
  return [
    agent.name,
    agentModelString(agent.config),
    `reasoning ${formatReasoningSelection(agent.config.reasoning)}`,
    directory,
  ].join(" · ");
}
