/**
 * Chat commands available when typing "/" in the chat input.
 * Used for help text and command suggestions/autocomplete.
 */
export interface ChatCommandInfo {
  readonly name: string;
  readonly description: string;
  /** Argument hint shown in autocomplete and /help, e.g. "[agent]". */
  readonly usage?: string;
  /** Set for entries that come from a skill rather than a built-in command. */
  readonly source?: "skill";
}

export const CHAT_COMMANDS: readonly ChatCommandInfo[] = [
  { name: "agents", description: "List all available agents" },
  { name: "clear", description: "Clear the screen" },
  { name: "compact", description: "Summarize background history to save tokens" },
  { name: "config", description: "Show or modify agent configuration" },
  { name: "context", description: "Show context window usage and token breakdown" },
  {
    name: "work",
    description: "Show saved task state and compaction records ('/work clear' discards them)",
  },
  { name: "copy", description: "Copy the last agent response to clipboard" },
  { name: "cost", description: "Show conversation token usage and estimated cost" },
  { name: "exit", description: "Exit the chat" },
  { name: "export", description: "Export the conversation to a markdown file", usage: "[path]" },
  { name: "fork", description: "Fork conversation (new branch from last message)" },
  { name: "help", description: "Show available commands and shortcuts", usage: "[command]" },
  { name: "mcp", description: "Show MCP server status and connections" },
  {
    name: "mode",
    description: "Switch between safe mode and yolo mode for tool approvals",
    usage: "[allow|disallow <cmd>]",
  },
  {
    name: "model",
    description: "Show or change model and reasoning effort",
    usage: "[model | reasoning <level>]",
  },
  { name: "resume", description: "Browse and resume a past conversation" },
  { name: "retry", description: "Re-send your last message" },
  { name: "new", description: "Start a new conversation (clear context)" },
  { name: "skills", description: "List and view available skills" },
  { name: "stats", description: "Show session statistics and usage summary" },
  {
    name: "switch",
    description: "Switch to a different agent in the same conversation",
    usage: "[agent]",
  },
  { name: "theme", description: "Switch between light and dark theme", usage: "light|dark" },
  { name: "tools", description: "List all agent tools by category" },
  {
    name: "workflows",
    description: "List workflows or send action (e.g. create) to the agent",
    usage: "[action]",
  },
] as const;

/**
 * Skills registered as invokable slash commands. Populated once at chat
 * startup from the SkillService (see setSkillCommands) so both the autocomplete
 * menu and the command parser can treat skills exactly like built-in commands.
 */
let skillCommands: readonly ChatCommandInfo[] = [];

/**
 * Register the available skills as slash commands. Any skill whose name
 * collides with a built-in command is dropped so built-ins always win.
 */
export function setSkillCommands(skills: readonly ChatCommandInfo[]): void {
  const reserved = new Set(CHAT_COMMANDS.map((cmd) => cmd.name.toLowerCase()));
  skillCommands = skills
    .filter((skill) => !reserved.has(skill.name.toLowerCase()))
    .map((skill) => ({ ...skill, source: "skill" as const }));
}

/** Names of all registered skill commands, lower-cased, for parser routing. */
export function getSkillCommandNames(): ReadonlySet<string> {
  return new Set(skillCommands.map((skill) => skill.name.toLowerCase()));
}

/**
 * Filter commands for autocomplete. Built-in commands and skills are merged
 * (built-ins first). Prefix matches rank first (in list order), then substring
 * matches (so "/ode" still surfaces /model and /mode). Case-insensitive.
 */
export function filterCommandsByPrefix(query: string): readonly ChatCommandInfo[] {
  const lower = query.toLowerCase();
  const all = [...CHAT_COMMANDS, ...skillCommands];
  const prefixMatches = all.filter((cmd) => cmd.name.toLowerCase().startsWith(lower));
  if (lower.length === 0) return prefixMatches;
  const substringMatches = all.filter(
    (cmd) => !cmd.name.toLowerCase().startsWith(lower) && cmd.name.toLowerCase().includes(lower),
  );
  return [...prefixMatches, ...substringMatches];
}
