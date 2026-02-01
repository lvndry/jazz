/**
 * Chat commands available when typing "/" in the chat input.
 * Used for help text and command suggestions/autocomplete.
 */
export interface ChatCommandInfo {
  readonly name: string;
  readonly description: string;
}

export const CHAT_COMMANDS: readonly ChatCommandInfo[] = [
  { name: "new", description: "Start a new conversation (clear context)" },
  { name: "help", description: "Show this help message" },
  { name: "status", description: "Show current conversation status" },
  { name: "tools", description: "List all agent tools by category" },
  { name: "agents", description: "List all available agents" },
  { name: "switch", description: "Switch to a different agent in the same conversation" },
  { name: "clear", description: "Clear the screen" },
  { name: "compact", description: "Summarize background history to save tokens" },
  { name: "context", description: "Show context window usage and token breakdown" },
  { name: "copy", description: "Copy the last agent response to clipboard" },
  { name: "skills", description: "List and view available skills" },
  { name: "exit", description: "Exit the chat" },
] as const;

/**
 * Filter commands by prefix (e.g. "s" matches status, skills, switch).
 * Case-insensitive.
 */
export function filterCommandsByPrefix(prefix: string): readonly ChatCommandInfo[] {
  const lower = prefix.toLowerCase();
  return CHAT_COMMANDS.filter((cmd) => cmd.name.toLowerCase().startsWith(lower));
}
