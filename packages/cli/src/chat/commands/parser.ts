import {
  findBuiltinCommand,
  getMcpPromptCommandNames,
  getPluginCommandNames,
  getSkillCommandNames,
} from "./constants";
import { startsWithPath } from "./path-message";
import type { SpecialCommand } from "./types";

/** What a message starts with to run the rest of the line in the shell. */
export const SHELL_ESCAPE_PREFIX = "! ";

const SHELL_ESCAPE_PATTERN = /^![ \t]/;

/**
 * Whether a message is a shell escape: a `!` followed by a space or tab, after
 * any leading whitespace. `!!! urgent` and `!important` are prose.
 */
export function isShellEscape(input: string): boolean {
  return SHELL_ESCAPE_PATTERN.test(input.trimStart());
}

/**
 * Whether a message is handled as a command (a slash command or a shell
 * escape) rather than sent to the agent.
 */
export function isCommandInput(input: string): boolean {
  return input.trimStart().startsWith("/") || isShellEscape(input);
}

/**
 * Parse special commands from user input.
 *
 * Slash commands start with "/" and may have arguments. A shell escape (see
 * `isShellEscape`) keeps its complete command in one argument.
 * Examples: /new, /help, /switch agent-name, ! git status
 */
export function parseSpecialCommand(input: string): SpecialCommand {
  const trimmed = input.trim();

  if (isShellEscape(trimmed)) {
    const command = trimmed.slice(1).trim();
    return command.length > 0 ? { type: "shell", args: [command] } : { type: "unknown", args: [] };
  }

  if (!trimmed.startsWith("/")) {
    return { type: "unknown", args: [] };
  }

  const parts = trimmed.slice(1).split(/\s+/);
  const command = parts[0]?.toLowerCase() || "";
  const args = parts.slice(1);

  const builtin = findBuiltinCommand(command);
  if (builtin !== undefined) {
    return { type: builtin.type, args };
  }

  // A slash command that matches a registered skill runs that skill.
  // args[0] is the skill name (mirrors the "unknown" convention).
  if (getSkillCommandNames().has(command)) {
    return { type: "runSkill", args: [command, ...args] };
  }

  if (getMcpPromptCommandNames().has(command)) {
    return { type: "runMcpPrompt", args: [command, ...args] };
  }

  if (getPluginCommandNames().has(command)) {
    return { type: "runPluginCommand", args: [command, ...args] };
  }

  if (startsWithPath(`/${parts[0] ?? ""}`)) {
    return { type: "prose", args: [] };
  }
  return { type: "unknown", args: [command, ...args] };
}
