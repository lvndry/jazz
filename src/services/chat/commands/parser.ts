import type { SpecialCommand } from "./types";

/**
 * Parse special commands from user input.
 *
 * Special commands start with "/" and may have arguments.
 * Examples: /new, /help, /switch agent-name
 */
export function parseSpecialCommand(input: string): SpecialCommand {
  const trimmed = input.trim();

  if (!trimmed.startsWith("/")) {
    return { type: "unknown", args: [] };
  }

  const parts = trimmed.slice(1).split(/\s+/);
  const command = parts[0]?.toLowerCase() || "";
  const args = parts.slice(1);

  switch (command) {
    case "new":
      return { type: "new", args };
    case "help":
      return { type: "help", args };
    case "status":
      return { type: "status", args };
    case "clear":
      return { type: "clear", args };
    case "tools":
      return { type: "tools", args };
    case "agents":
      return { type: "agents", args };
    case "switch":
      return { type: "switch", args };
    case "compact":
      return { type: "compact", args };
    case "copy":
      return { type: "copy", args };
    case "skills":
      return { type: "skills", args };
    case "context":
      return { type: "context", args };
    case "cost":
      return { type: "cost", args };
    case "workflows":
      return { type: "workflows", args };
    default:
      return { type: "unknown", args: [command, ...args] };
  }
}
