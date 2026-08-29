import type { ToolCategory } from "@/core/types";
import { toPascalCase } from "@/core/utils/string";

export const HTTP_CATEGORY: ToolCategory = {
  id: "http",
  displayName: "HTTP",
  loadTier: "eager",
};
export const FILE_MANAGEMENT_CATEGORY: ToolCategory = {
  id: "file_management",
  displayName: "File Management",
  loadTier: "eager",
};
export const SHELL_COMMANDS_CATEGORY: ToolCategory = {
  id: "shell_commands",
  displayName: "Shell Commands",
  loadTier: "eager",
};
export const WEB_SEARCH_CATEGORY: ToolCategory = {
  id: "search",
  displayName: "Web Search",
  loadTier: "eager",
};
export const WEB_FETCH_CATEGORY: ToolCategory = {
  id: "web_fetch",
  displayName: "Web Fetch",
  loadTier: "eager",
};
export const SKILLS_CATEGORY: ToolCategory = {
  id: "skills",
  displayName: "Skills",
  loadTier: "eager",
};
export const CONTEXT_CATEGORY: ToolCategory = {
  id: "context",
  displayName: "Context",
  loadTier: "eager",
};
export const SEARCH_TOOLS_CATEGORY: ToolCategory = {
  id: "search_tools",
  displayName: "Tool Search",
  loadTier: "eager",
};
export const SUBAGENT_CATEGORY: ToolCategory = {
  id: "subagent",
  displayName: "Sub Agents",
  loadTier: "eager",
};
export const PERCEPTION_CATEGORY: ToolCategory = {
  id: "perception",
  displayName: "Perception Delegation",
  loadTier: "eager",
};
export const TODO_CATEGORY: ToolCategory = { id: "todo", displayName: "Todo", loadTier: "eager" };
export const MEMORY_CATEGORY: ToolCategory = {
  id: "memory",
  displayName: "Memory",
  loadTier: "deferred",
};
export const WORKSPACE_CATEGORY: ToolCategory = {
  id: "workspace",
  displayName: "Workspace",
  loadTier: "eager",
};
export const PEERS_CATEGORY: ToolCategory = {
  id: "peers",
  displayName: "Peers",
  loadTier: "deferred",
};
export const REMINDER_CATEGORY: ToolCategory = {
  id: "reminders",
  displayName: "Reminders",
  loadTier: "deferred",
};
export const WAKE_TRIGGER_CATEGORY: ToolCategory = {
  id: "wake_triggers",
  displayName: "Wake Triggers",
  loadTier: "deferred",
};
export const JOB_QUEUE_CATEGORY: ToolCategory = {
  id: "job_queue",
  displayName: "Background Jobs",
  loadTier: "deferred",
};
export const USER_INTERACTION_CATEGORY: ToolCategory = {
  id: "user_interaction",
  displayName: "User Interaction",
  loadTier: "eager",
};
export const WEB_APP_CATEGORY: ToolCategory = {
  id: "web_app",
  displayName: "Web App",
  loadTier: "deferred",
};

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
  WORKSPACE_CATEGORY,
  REMINDER_CATEGORY,
  WAKE_TRIGGER_CATEGORY,
  JOB_QUEUE_CATEGORY,
  CONTEXT_CATEGORY,
  SEARCH_TOOLS_CATEGORY,
  SUBAGENT_CATEGORY,
  PERCEPTION_CATEGORY,
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
  PERCEPTION_CATEGORY,
  USER_INTERACTION_CATEGORY,
  CONTEXT_CATEGORY,
  SEARCH_TOOLS_CATEGORY,
  WEB_FETCH_CATEGORY,
  JOB_QUEUE_CATEGORY,
  WORKSPACE_CATEGORY,
] as const;

/**
 * Category for tools discovered from one MCP server.
 * Id format: `mcp_<servername>` (lowercase). Always `deferred` — server tool counts are
 * unbounded and user-configured.
 */
export function mcpToolCategory(serverName: string): ToolCategory {
  return {
    id: `mcp_${serverName.toLowerCase()}`,
    displayName: `${toPascalCase(serverName)} (MCP)`,
    loadTier: "deferred",
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
