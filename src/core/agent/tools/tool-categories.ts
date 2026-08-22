import type { ToolCategory } from "@/core/types";
import { toPascalCase } from "@/core/utils/string";

export const HTTP_CATEGORY: ToolCategory = { id: "http", displayName: "HTTP" };
export const FILE_MANAGEMENT_CATEGORY: ToolCategory = {
  id: "file_management",
  displayName: "File Management",
};
export const SHELL_COMMANDS_CATEGORY: ToolCategory = {
  id: "shell_commands",
  displayName: "Shell Commands",
};
export const WEB_SEARCH_CATEGORY: ToolCategory = { id: "search", displayName: "Web Search" };
export const WEB_FETCH_CATEGORY: ToolCategory = { id: "web_fetch", displayName: "Web Fetch" };
export const SKILLS_CATEGORY: ToolCategory = { id: "skills", displayName: "Skills" };
export const CONTEXT_CATEGORY: ToolCategory = { id: "context", displayName: "Context" };
export const SUBAGENT_CATEGORY: ToolCategory = { id: "subagent", displayName: "Sub Agents" };
export const TODO_CATEGORY: ToolCategory = { id: "todo", displayName: "Todo" };
export const MEMORY_CATEGORY: ToolCategory = { id: "memory", displayName: "Memory" };
export const REMINDER_CATEGORY: ToolCategory = { id: "reminders", displayName: "Reminders" };
export const USER_INTERACTION_CATEGORY: ToolCategory = {
  id: "user_interaction",
  displayName: "User Interaction",
};
export const WEB_APP_CATEGORY: ToolCategory = { id: "web_app", displayName: "Web App" };

/**
 * All available builtin tool categories (excludes per-server MCP categories).
 */
export const ALL_CATEGORIES: readonly ToolCategory[] = [
  FILE_MANAGEMENT_CATEGORY,
  SHELL_COMMANDS_CATEGORY,
  HTTP_CATEGORY,
  WEB_SEARCH_CATEGORY,
  WEB_FETCH_CATEGORY,
  SKILLS_CATEGORY,
  TODO_CATEGORY,
  MEMORY_CATEGORY,
  REMINDER_CATEGORY,
  CONTEXT_CATEGORY,
  SUBAGENT_CATEGORY,
  USER_INTERACTION_CATEGORY,
  WEB_APP_CATEGORY,
] as const;

/**
 * Builtin tool categories that are managed internally and hidden from manual selection.
 */
export const BUILTIN_TOOL_CATEGORIES: readonly ToolCategory[] = [
  SKILLS_CATEGORY,
  TODO_CATEGORY,
  SUBAGENT_CATEGORY,
  USER_INTERACTION_CATEGORY,
  CONTEXT_CATEGORY,
  WEB_FETCH_CATEGORY,
] as const;

/**
 * Category for tools discovered from one MCP server.
 * Id format: `mcp_<servername>` (lowercase).
 */
export function mcpToolCategory(serverName: string): ToolCategory {
  return {
    id: `mcp_${serverName.toLowerCase()}`,
    displayName: `${toPascalCase(serverName)} (MCP)`,
  };
}

/**
 * Create mappings between category display names and IDs.
 */
export function createCategoryMappings(): {
  displayNameToId: Map<string, string>;
  idToDisplayName: Map<string, string>;
} {
  const displayNameToId = new Map<string, string>();
  const idToDisplayName = new Map<string, string>();

  for (const category of ALL_CATEGORIES) {
    displayNameToId.set(category.displayName, category.id);
    idToDisplayName.set(category.id, category.displayName);
  }

  return {
    displayNameToId,
    idToDisplayName,
  };
}
