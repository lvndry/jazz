/**
 * The chat slash-command registry.
 *
 * `CHAT_COMMANDS` is the one list of built-in commands. The parser routes by it
 * (names and aliases), /help renders it, the composer's autocomplete filters it,
 * and `bun run docs:chat-commands` generates the in-chat table in
 * `docs/commands.md` from it. Adding a command is one entry here plus its
 * handler case; nothing else lists commands by hand.
 *
 * Skills, MCP prompts and plugin commands register at chat startup through
 * `setSkillCommands`, `setMcpPromptCommands` and `setPluginCommands`. Built-ins
 * win every name collision, including against aliases.
 */
import { report, type TerminalReport } from "@jazz/core/interfaces/terminal";
import { closestMatch } from "@jazz/core/utils/string";
import type { BuiltinCommandType } from "./types";

/** How /help and the docs show the shell escape, which is not a slash command. */
export const SHELL_ESCAPE_FORM = "! <command>";

/** One row the autocomplete menu and /help can show. */
export interface ChatCommandInfo {
  readonly name: string;
  readonly description: string;
  /** Argument hint shown in autocomplete and /help, e.g. "[agent]". */
  readonly usage?: string;
  /** Set for entries that come from a skill, MCP server, or plugin rather than a built-in command. */
  readonly source?: "skill" | "mcp-prompt" | "plugin";
  /** Other names that run the same command, e.g. `/stats` for `/info`. */
  readonly aliases?: readonly string[];
}

/** One way to call a command and what it does, shown by `/help <command>`. */
export interface ChatCommandForm {
  readonly form: string;
  readonly meaning: string;
}

/** A built-in command: what the parser routes, /help lists, and the docs table shows. */
export interface BuiltinChatCommand extends ChatCommandInfo {
  /** The handler this command dispatches to. */
  readonly type: BuiltinCommandType;
  /** Every form of the command, for `/help <command>` and the docs. */
  readonly forms?: readonly ChatCommandForm[];
  /** A closing line for `/help <command>`. */
  readonly note?: string;
  /** A docs page anchor with more detail, relative to `docs/commands.md`. */
  readonly docsLink?: { readonly label: string; readonly href: string };
}

export const CHAT_COMMANDS: readonly BuiltinChatCommand[] = [
  { name: "agents", type: "agents", description: "List all available agents" },
  {
    name: "peers",
    type: "peers",
    description: "List configured peers and what each may learn or do",
  },
  { name: "clear", type: "clear", description: "Clear the screen" },
  {
    name: "compact",
    type: "compact",
    description: "Summarize older history now, keeping recent messages",
  },
  {
    name: "config",
    type: "config",
    description: "Show the agent's configuration ('/config tools' toggles its tools)",
    usage: "[tools]",
  },
  {
    name: "context",
    type: "context",
    description: "Show context window usage and token breakdown",
  },
  {
    name: "work",
    type: "work",
    description: "Show saved task state and compaction records ('/work clear' discards them)",
    usage: "[clear]",
  },
  { name: "copy", type: "copy", description: "Copy the last agent response to clipboard" },
  {
    name: "cost",
    type: "cost",
    description: "Show conversation token usage and estimated cost, including sub-agents",
  },
  { name: "exit", type: "exit", description: "Exit the chat", aliases: ["quit"] },
  {
    name: "export",
    type: "export",
    description: "Export the conversation to a markdown file",
    usage: "[path]",
  },
  {
    name: "fork",
    type: "fork",
    description: "Fork conversation into a new branch (keeps full history)",
  },
  {
    name: "detach",
    type: "detach",
    description: "Continue this conversation on a registered SSH host after this turn",
    usage: "<host>",
  },
  {
    name: "goal",
    type: "goal",
    description: "Keep working toward an objective, turn after turn, in this conversation",
    usage: "[objective|pause|resume|clear|list|accept|decline]",
    forms: [
      {
        form: "/goal <objective>",
        meaning: "Keep working toward an objective, turn after turn, right here",
      },
      { form: "/goal", meaning: "Where this conversation's goal stands" },
      { form: "/goal pause", meaning: "Stop after the current turn; /goal resume continues" },
      { form: "/goal resume [note]", meaning: "Continue it; the note steers the next turn" },
      { form: "/goal clear", meaning: "Drop the goal" },
      {
        form: "/goal approve|reject|answer",
        meaning: "Answer what a goal left waiting in the background, and carry on",
      },
      { form: "/goal accept|decline <goal>", meaning: "Start or drop a goal Jazz proposed" },
      { form: "/goal list", meaning: "This conversation's goals" },
    ],
    note: "Esc pauses a goal. Leaving the chat offers to finish it in the background.",
    docsLink: { label: "Goals in chat", href: "#goals-in-chat" },
  },
  {
    name: "help",
    type: "help",
    description: "Show available commands and shortcuts",
    usage: "[command]",
  },
  {
    name: "loop",
    type: "loop",
    description: "Rerun a prompt on a schedule in the background",
    usage: "<every> <prompt>|cron|list|approve|reject|answer|pause|resume|cancel",
    forms: [
      {
        form: "/loop <every> <prompt>",
        meaning: "Rerun a prompt on a schedule, e.g. /loop 10m check the deploy",
      },
      {
        form: "/loop cron <m h dom mon dow> <prompt>",
        meaning: "Same, on a cron schedule in this machine's timezone",
      },
      { form: "/loop list", meaning: "This conversation's loops and what each last did" },
      { form: "/loop approve <loop>", meaning: "Allow the step its run is waiting on" },
      {
        form: "/loop reject <loop> [why]",
        meaning: "Refuse that step; the reason goes to the agent",
      },
      {
        form: "/loop answer <loop> <answer>",
        meaning: "Answer the question its run is waiting on",
      },
      { form: "/loop pause|resume|cancel <loop>", meaning: "Stop, restart, or end a loop" },
    ],
    note: "Loops run in the background while `jazz daemon` runs; each run ends the loop once its purpose is met.",
    docsLink: { label: "Loops in chat", href: "#loops-in-chat" },
  },
  {
    name: "memory",
    type: "memory",
    description: "Show what this agent has remembered about you, or forget one file",
    usage: "[forget <path>]",
  },
  {
    name: "limit",
    type: "limit",
    description: "Set a session turn, cost, or token limit (applied immediately)",
    usage: "[turns|usd|tokens <value>|clear]",
  },
  {
    name: "mcp",
    type: "mcp",
    description: "Show MCP servers, or reconnect one",
    usage: "[reconnect <server>]",
  },
  {
    name: "mode",
    type: "mode",
    description: "Switch between safe mode and yolo mode for tool approvals (also Shift+Tab)",
    usage: "[allow|disallow <cmd>]",
  },
  {
    name: "model",
    type: "model",
    description: "Change the agent's model for this session only",
    usage: "[model]",
    aliases: ["models"],
  },
  {
    name: "reasoning",
    type: "reasoning",
    description: "Change reasoning for this session only",
    usage: "[minimal|low|medium|high|xhigh|max|disable]",
  },
  { name: "resume", type: "resume", description: "Browse and resume a past conversation" },
  { name: "retry", type: "retry", description: "Re-send your last message" },
  { name: "new", type: "new", description: "Start a new conversation (clear context)" },
  {
    name: "skills",
    type: "skills",
    description: "Search installed skills by name, source, or description",
  },
  {
    name: "info",
    type: "info",
    description: "Show conversation id, title, usage, and log file paths for this session",
    aliases: ["stats"],
  },
  {
    name: "switch",
    type: "switch",
    description: "Switch to a different agent in the same conversation",
    usage: "[agent]",
  },
  {
    name: "theme",
    type: "theme",
    description: "List themes, or switch to one and save it",
    usage: "[name] [dark|light]",
  },
  { name: "tools", type: "tools", description: "List all agent tools by category" },
  {
    name: "workflows",
    type: "workflows",
    description: "List workflows, or send an action (e.g. create) to the agent",
    usage: "[action]",
  },
];

/** Every name and alias a built-in answers to, lower-cased. */
const BUILTIN_BY_NAME: ReadonlyMap<string, BuiltinChatCommand> = new Map(
  CHAT_COMMANDS.flatMap((command) =>
    [command.name, ...(command.aliases ?? [])].map(
      (name) => [name.toLowerCase(), command] as const,
    ),
  ),
);

/** The built-in command a name or alias runs, if any. Case-insensitive, leading `/` allowed. */
export function findBuiltinCommand(name: string): BuiltinChatCommand | undefined {
  return BUILTIN_BY_NAME.get(name.toLowerCase().replace(/^\//, ""));
}

/** Whether a whole message is a command that ends the chat (`/exit` or an alias of it). */
export function isExitCommand(message: string): boolean {
  const trimmed = message.trim();
  return trimmed.startsWith("/") && findBuiltinCommand(trimmed)?.type === "exit";
}

/** `/name usage`, the way a command is shown in lists. */
export function commandSignature(command: ChatCommandInfo): string {
  return `/${command.name}${command.usage ? ` ${command.usage}` : ""}`;
}

/**
 * What `/help <command>` says about a built-in, and what a command prints when it is run
 * without the arguments it needs: every form with its meaning, and the closing note.
 */
export function commandUsage(command: BuiltinChatCommand): TerminalReport {
  return report(
    `/${command.name}`,
    (command.forms ?? []).map((entry) => ({
      kind: "item",
      name: entry.form,
      detail: entry.meaning,
    })),
    command.note,
  );
}

/** The usage report for one built-in command by name, for handlers that print their own usage. */
export function builtinUsage(name: string): TerminalReport | undefined {
  const command = findBuiltinCommand(name);
  return command === undefined ? undefined : commandUsage(command);
}

/** Names a registered skill, MCP prompt, or plugin command may not take. */
function builtinNames(): string[] {
  return [...BUILTIN_BY_NAME.keys()];
}

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
  const reserved = new Set(builtinNames());
  skillCommands = skills
    .filter((skill) => !reserved.has(skill.name.toLowerCase()))
    .map((skill) => ({ ...skill, source: "skill" as const }));
}

/** Names of all registered skill commands, lower-cased, for parser routing. */
export function getSkillCommandNames(): ReadonlySet<string> {
  return new Set(skillCommands.map((skill) => skill.name.toLowerCase()));
}

/**
 * Prompts advertised by connected MCP servers, as `server:prompt` commands.
 *
 * MCP prompts are the user-initiated half of the protocol — templates a person
 * invokes deliberately, unlike tools, which the model calls. A slash command is
 * the shape that matches, so they are registered here alongside skills.
 */
let mcpPromptCommands: readonly ChatCommandInfo[] = [];

/**
 * Register connected servers' prompts as slash commands. Built-ins and skills
 * both win a name collision, so a server cannot shadow `/help`.
 */
export function setMcpPromptCommands(prompts: readonly ChatCommandInfo[]): void {
  const reserved = new Set([
    ...builtinNames(),
    ...skillCommands.map((skill) => skill.name.toLowerCase()),
  ]);
  mcpPromptCommands = prompts
    .filter((prompt) => !reserved.has(prompt.name.toLowerCase()))
    .map((prompt) => ({ ...prompt, source: "mcp-prompt" as const }));
}

/** Names of all registered MCP prompt commands, lower-cased, for parser routing. */
export function getMcpPromptCommandNames(): ReadonlySet<string> {
  return new Set(mcpPromptCommands.map((prompt) => prompt.name.toLowerCase()));
}

/**
 * Slash commands contributed by enabled plugins. Registered once at chat startup from the plugin
 * runtime (see setPluginCommands), so they route and autocomplete like built-ins.
 */
let pluginCommands: readonly ChatCommandInfo[] = [];

/**
 * Register enabled plugins' commands as slash commands. Built-ins, skills, and MCP prompts all win
 * a name collision, so a plugin cannot shadow `/help` or a skill command.
 */
export function setPluginCommands(commands: readonly ChatCommandInfo[]): void {
  const reserved = new Set([
    ...builtinNames(),
    ...skillCommands.map((skill) => skill.name.toLowerCase()),
    ...mcpPromptCommands.map((prompt) => prompt.name.toLowerCase()),
  ]);
  pluginCommands = commands
    .filter((command) => !reserved.has(command.name.toLowerCase()))
    .map((command) => ({ ...command, source: "plugin" as const }));
}

/** Names of all registered plugin commands, lower-cased, for parser routing. */
export function getPluginCommandNames(): ReadonlySet<string> {
  return new Set(pluginCommands.map((command) => command.name.toLowerCase()));
}

/**
 * The query inside a slash command the user is still choosing.
 *
 * Returns null once a space or newline appears: arguments have started, so
 * the picker should get out of the way.
 */
export function slashCommandQuery(text: string): string | null {
  if (!text.startsWith("/")) return null;
  if (text.includes("\n")) return null;
  const rest = text.slice(1);
  if (/\s/.test(rest)) return null;
  return rest;
}

/** The names a command answers to: its name, plus a built-in's aliases. */
function namesOf(command: ChatCommandInfo): readonly string[] {
  return [command.name, ...(command.aliases ?? [])].map((name) => name.toLowerCase());
}

/** Every command the chat answers to right now: built-ins, then skills, MCP prompts, plugins. */
function allCommands(): readonly ChatCommandInfo[] {
  return [...CHAT_COMMANDS, ...skillCommands, ...mcpPromptCommands, ...pluginCommands];
}

/**
 * Filter commands for autocomplete. Built-in commands and skills are merged
 * (built-ins first). Prefix matches rank first (in list order), then substring
 * matches (so "/ode" still surfaces /model and /mode). A built-in also matches
 * by alias. Case-insensitive.
 */
export function filterCommandsByPrefix(query: string): readonly ChatCommandInfo[] {
  const lower = query.toLowerCase();
  const all = allCommands();
  const prefixMatches = all.filter((command) =>
    namesOf(command).some((name) => name.startsWith(lower)),
  );
  if (lower.length === 0) return prefixMatches;
  const substringMatches = all.filter(
    (command) =>
      !prefixMatches.includes(command) && namesOf(command).some((name) => name.includes(lower)),
  );
  return [...prefixMatches, ...substringMatches];
}

/** The registered skill, MCP prompt, and plugin commands, for /help's own sections. */
export function registeredCommands(): {
  readonly skills: readonly ChatCommandInfo[];
  readonly mcpPrompts: readonly ChatCommandInfo[];
  readonly plugins: readonly ChatCommandInfo[];
} {
  return { skills: skillCommands, mcpPrompts: mcpPromptCommands, plugins: pluginCommands };
}

/** Any command, built-in or registered, by name or alias. */
export function findCommand(name: string): ChatCommandInfo | undefined {
  const lower = name.toLowerCase().replace(/^\//, "");
  return allCommands().find((command) => namesOf(command).includes(lower));
}

/** The command a mistyped name most plausibly meant, for "did you mean". */
export function suggestCommand(typed: string): ChatCommandInfo | undefined {
  const known = allCommands().flatMap((command) => namesOf(command));
  const match = closestMatch(typed.replace(/^\//, ""), known);
  return match === undefined ? undefined : findCommand(match);
}
