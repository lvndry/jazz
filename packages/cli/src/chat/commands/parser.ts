import { getMcpPromptCommandNames, getSkillCommandNames } from "./constants";
import type { SpecialCommand } from "./types";

/**
 * Parse special commands from user input.
 *
 * Slash commands start with "/" and may have arguments. A leading "!" is
 * preserved as a shell escape whose complete command is kept in one argument.
 * Examples: /new, /help, /switch agent-name, ! git status
 */
export function parseSpecialCommand(input: string): SpecialCommand {
  const trimmed = input.trim();

  if (trimmed.startsWith("!")) {
    const command = trimmed.slice(1).trim();
    return command.length > 0 ? { type: "shell", args: [command] } : { type: "unknown", args: [] };
  }

  if (!trimmed.startsWith("/")) {
    return { type: "unknown", args: [] };
  }

  const parts = trimmed.slice(1).split(/\s+/);
  const command = parts[0]?.toLowerCase() || "";
  const args = parts.slice(1);

  switch (command) {
    case "new":
      return { type: "new", args };
    case "fork":
      return { type: "fork", args };
    case "help":
      return { type: "help", args };
    case "clear":
      return { type: "clear", args };
    case "tools":
      return { type: "tools", args };
    case "agents":
      return { type: "agents", args };
    case "peers":
      return { type: "peers", args };
    case "switch":
      return { type: "switch", args };
    case "compact":
      return { type: "compact", args };
    case "copy":
      return { type: "copy", args };
    case "model":
      return { type: "model", args };
    case "reasoning":
      return { type: "reasoning", args };
    case "config":
      return { type: "config", args };
    case "skills":
      return { type: "skills", args };
    case "context":
      return { type: "context", args };
    case "work":
      return { type: "work", args };
    case "cost":
      return { type: "cost", args };
    case "workflows":
      return { type: "workflows", args };
    case "stats":
      return { type: "stats", args };
    case "mcp":
      return { type: "mcp", args };
    case "mode":
      return { type: "mode", args };
    case "resume":
      return { type: "resume", args };
    case "theme":
      return { type: "theme", args };
    case "export":
      return { type: "export", args };
    case "retry":
      return { type: "retry", args };
    default:
      // A slash command that matches a registered skill runs that skill.
      // args[0] is the skill name (mirrors the "unknown" convention).
      if (getSkillCommandNames().has(command)) {
        return { type: "runSkill", args: [command, ...args] };
      }

      if (getMcpPromptCommandNames().has(command)) {
        return { type: "runMcpPrompt", args: [command, ...args] };
      }
      return { type: "unknown", args: [command, ...args] };
  }
}
