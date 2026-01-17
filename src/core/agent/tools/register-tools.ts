import { Effect, Layer } from "effect";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import React from "react";
import type { AgentConfigService } from "../../interfaces/agent-config";
import type { LoggerService } from "../../interfaces/logger";
import { LoggerServiceTag } from "../../interfaces/logger";
import type { MCPServerManager } from "../../interfaces/mcp-server";
import { MCPServerManagerTag } from "../../interfaces/mcp-server";
import type { TerminalService } from "../../interfaces/terminal";
import { ink, TerminalServiceTag } from "../../interfaces/terminal";
import type { ToolRegistry } from "../../interfaces/tool-registry";
import { ToolRegistryTag } from "../../interfaces/tool-registry";
import type { ToolCategory } from "../../types";
import type { MCPTool } from "../../types/mcp";
import { extractServerNamesFromToolNames } from "../../utils/mcp-utils";
import { calendarTools } from "./calendar-tools";
import {
  createCdTool,
  createEditFileTool,
  createExecuteEditFileTool,
  createExecuteMkdirTool,
  createExecuteRmTool,
  createExecuteWriteFileTool,
  createFindPathTool,
  createFindTool,
  createGrepTool,
  createHeadTool,
  createLsTool,
  createMkdirTool,
  createPwdTool,
  createReadFileTool,
  createReadPdfTool,
  createRmTool,
  createStatTool,
  createTailTool,
  createWriteFileTool,
} from "./fs-tools";
import {
  createExecuteGitAddTool,
  createExecuteGitCheckoutTool,
  createExecuteGitCommitTool,
  createExecuteGitMergeTool,
  createExecuteGitPullTool,
  createExecuteGitPushTool,
  createExecuteGitTagTool,
  createGitAddTool,
  createGitBlameTool,
  createGitBranchTool,
  createGitCheckoutTool,
  createGitCommitTool,
  createGitDiffTool,
  createGitLogTool,
  createGitMergeTool,
  createGitPullTool,
  createGitPushTool,
  createGitReflogTool,
  createGitStatusTool,
  createGitTagTool,
} from "./git-tools";
import {
  createAddLabelsToEmailTool,
  createBatchModifyEmailsTool,
  createCreateLabelTool,
  createDeleteEmailTool,
  createDeleteLabelTool,
  createExecuteDeleteEmailTool,
  createExecuteDeleteLabelTool,
  createExecuteTrashEmailTool,
  createGetEmailTool,
  createListEmailsTool,
  createListLabelsTool,
  createRemoveLabelsFromEmailTool,
  createSearchEmailsTool,
  createSendEmailTool,
  createTrashEmailTool,
  createUpdateLabelTool,
} from "./gmail-tools";
import { createHttpRequestTool } from "./http-tools";
import { registerMCPServerTools } from "./mcp-tools";
import { createExecuteCommandApprovedTool, createExecuteCommandTool } from "./shell-tools";
import { createWebSearchTool } from "./web-search-tools";

/**
 * Dependencies required for MCP tool registration
 */
type MCPRegistrationDependencies =
  | ToolRegistry
  | MCPServerManager
  | AgentConfigService
  | LoggerService
  | TerminalService;

/**
 * Tool registration module
 */

/**
 * Register all tools including MCP tools
 *
 * MCP tools use lazy connections - servers connect only when tools are invoked.
 * This prevents the CLI from hanging due to long-running child processes.
 *
 * MCP tool registration is deferred to avoid startup delays - tools are registered
 * lazily when first accessed rather than at startup.
 */
export function registerAllTools(): Effect.Effect<void, Error, MCPRegistrationDependencies> {
  return Effect.gen(function* () {
    yield* registerGmailTools();
    yield* registerCalendarTools();
    yield* registerFileTools();
    yield* registerShellTools();
    yield* registerGitTools();
    yield* registerSearchTools();
    yield* registerHttpTools();
    // MCP tools registered without connecting - they connect lazily on first use
    yield* registerMCPToolsLazy();
  });
}

/**
 * Register MCP server tools lazily without connecting
 *
 * This function skips MCP tool registration at startup to avoid delays.
 * Tools will be discovered and registered on-demand when agents need them.
 */
export function registerMCPToolsLazy(): Effect.Effect<
  void,
  Error,
  ToolRegistry | MCPServerManager | AgentConfigService | LoggerService
> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    yield* logger.debug("MCP tools will be registered on-demand when agents need them");
    // No registration at startup - tools registered per-agent based on their tool requirements
  });
}

/**
 * Register MCP tools for a specific agent based on their tool requirements
 *
 * Only connects to and registers tools from MCP servers that the agent actually uses.
 * This avoids connecting to unnecessary servers.
 *
 * @param agentToolNames - The list of tool names the agent uses
 */
export function registerMCPToolsForAgent(
  agentToolNames: readonly string[],
): Effect.Effect<
  void,
  Error,
  ToolRegistry | MCPServerManager | AgentConfigService | LoggerService | TerminalService
> {
  return Effect.gen(function* () {
    const mcpManager = yield* MCPServerManagerTag;
    const registry = yield* ToolRegistryTag;
    const logger = yield* LoggerServiceTag;

    // Extract MCP tool names (format: mcp_<servername>_<toolname>)
    const mcpToolNames = agentToolNames.filter((name) => name.startsWith("mcp_"));

    if (mcpToolNames.length === 0) {
      // Agent doesn't use any MCP tools
      return;
    }

    // Extract unique server names from tool names using robust parsing
    const serverNamesResult = yield* extractServerNamesFromToolNames(mcpToolNames).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          const errorMessage =
            typeof error === "object" && error !== null && "_tag" in error && "reason" in error
              ? (error as { reason: string }).reason
              : String(error);
          yield* logger.warn(`Failed to parse server names from MCP tool names: ${errorMessage}`);
          // Return empty set on error - agent won't use MCP tools
          return Effect.succeed(new Set<string>());
        }),
      ),
    );
    const serverNames = serverNamesResult as Set<string>;

    if (serverNames.size === 0) {
      yield* logger.debug("No MCP servers identified from agent tools");
      return;
    }

    yield* logger.debug(
      `Agent uses tools from ${serverNames.size} MCP server(s): ${Array.from(serverNames).join(", ")}`,
    );

    // Get all configured MCP servers
    const allServers = yield* mcpManager.listServers();

    // Filter to only servers the agent needs (case-insensitive comparison)
    const neededServers = allServers.filter((server) =>
      Array.from(serverNames).some(
        (name) => name.toLowerCase() === server.name.toLowerCase(),
      ),
    );

    if (neededServers.length === 0) {
      yield* logger.warn(
        `Agent references MCP tools but no matching servers found. Expected: ${Array.from(serverNames).join(", ")}`,
      );
      return;
    }

    // Connect to and register tools from only the needed servers
    for (const serverConfig of neededServers) {
      // Skip disabled servers
      if (serverConfig.enabled === false) {
        yield* logger.debug(`Skipping disabled MCP server: ${serverConfig.name}`);
        continue;
      }

      yield* Effect.gen(function* () {
        const terminal = yield* TerminalServiceTag;
        const serverName = serverConfig.name;

        // Generate a unique ID for this connection log entry
        const logId = `mcp-connecting-${serverName}-${Date.now()}`;

        // Show connecting message with spinner
        yield* terminal.log(
          ink(
            React.createElement(
              Box,
              {},
              React.createElement(Text, { color: "cyan" }, [
                React.createElement(Spinner, { key: "spinner", type: "dots" }),
              ]),
              React.createElement(Text, {}, ` Connecting to ${serverName} MCP server...`),
            ),
          ),
          logId,
        );

        yield* logger.debug(`Discovering tools from MCP server ${serverName}...`);

        // Use discoverTools() which handles connect/disconnect automatically
        const mcpToolsResult = yield* mcpManager.discoverTools(serverConfig).pipe(
          Effect.catchAll((error) =>
            Effect.gen(function* () {
              // Update log to show error
              const errorMessage = String(error);
              yield* terminal.updateLog(
                logId,
                ink(
                  React.createElement(Text, { color: "red" }, `✗ Failed to connect to ${serverName} MCP server: ${errorMessage}`),
                ),
              );
              // Return empty array on error - skip this server
              return Effect.succeed([] as readonly MCPTool[]);
            }),
          ),
        );
        const mcpTools = mcpToolsResult as readonly MCPTool[];

        yield* logger.debug(`Discovered ${mcpTools.length} tool(s) from MCP server ${serverName}`);

        // Update the log entry to show success (replaces spinner)
        yield* terminal.updateLog(
          logId,
          ink(
            React.createElement(Text, { color: "green" }, `✓ Successfully connected to ${serverName} MCP server`),
          ),
        );

        // Determine category for tools
        const category: ToolCategory =
          serverConfig.name.toLowerCase() === "mongodb"
            ? MCP_MONGODB_CATEGORY
            : {
                id: `mcp_${serverConfig.name.toLowerCase()}`,
                displayName: `${serverConfig.name} (MCP)`,
              };

        // Register tools with server config for lazy reconnection
        const registerTool = registry.registerForCategory(category);
        const jazzTools = yield* registerMCPServerTools(serverConfig, mcpTools);

        for (const tool of jazzTools) {
          // Only register tools that the agent actually uses
          const toolName = tool.name;
          if (agentToolNames.includes(toolName)) {
            yield* registerTool(tool);
          }
        }

        yield* logger.info(
          `Registered ${jazzTools.filter((t) => agentToolNames.includes(t.name)).length} MCP tools from ${serverConfig.name} for agent`,
        );
      }).pipe(
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            // Log error but continue with other servers
            const errorMessage = error instanceof Error ? error.message : String(error);
            yield* logger.warn(
              `Failed to register tools from MCP server ${serverConfig.name}: ${errorMessage}`,
            );
          }),
        ),
      );
    }
  });
}

/**
 * Register all MCP tools for tool selection/listing purposes
 *
 * This function connects to MCP servers, discovers their tools, and registers them
 * so they appear in tool selection interfaces (e.g., when editing agents).
 * Unlike registerMCPToolsLazy(), this actually registers the tools.
 *
 * Used when we need MCP tools to be available for selection, such as in
 * agent creation/editing workflows.
 */
export function registerMCPToolsForSelection(): Effect.Effect<
  void,
  Error,
  ToolRegistry | MCPServerManager | AgentConfigService | LoggerService | TerminalService
> {
  return Effect.gen(function* () {
    const mcpManager = yield* MCPServerManagerTag;
    const registry = yield* ToolRegistryTag;
    const logger = yield* LoggerServiceTag;

    // Get all configured MCP servers
    const servers = yield* mcpManager.listServers();

    if (servers.length === 0) {
      yield* logger.debug("No MCP servers configured");
      return;
    }

    yield* logger.debug(`Discovering tools from ${servers.length} MCP server(s)...`);

    for (const serverConfig of servers) {
      // Skip disabled servers
      if (serverConfig.enabled === false) {
        yield* logger.debug(`Skipping disabled MCP server: ${serverConfig.name}`);
        continue;
      }

      yield* Effect.gen(function* () {
        yield* logger.debug(`Connecting to MCP server ${serverConfig.name} for tool discovery...`);

        // Connect to server to discover tools
        yield* mcpManager.connectServer(serverConfig);

        // Get tools from server
        const mcpTools = yield* mcpManager.getServerTools(serverConfig.name);

        yield* logger.debug(
          `Discovered ${mcpTools.length} tools from MCP server ${serverConfig.name}`,
        );

        // Immediately disconnect - tools will reconnect lazily when invoked
        yield* mcpManager.disconnectServer(serverConfig.name);
        yield* logger.debug(`Disconnected from MCP server ${serverConfig.name} (lazy mode)`);

        // Determine category for tools
        const category: ToolCategory =
          serverConfig.name.toLowerCase() === "mongodb"
            ? MCP_MONGODB_CATEGORY
            : {
                id: `mcp_${serverConfig.name.toLowerCase()}`,
                displayName: `${serverConfig.name} (MCP)`,
              };

        // Register tools with server config for lazy reconnection
        const registerTool = registry.registerForCategory(category);
        const jazzTools = yield* registerMCPServerTools(serverConfig, mcpTools);

        for (const tool of jazzTools) {
          // MCP tools satisfy ToolRequirements as they use MCPServerManager, LoggerService, etc.
          yield* registerTool(tool);
        }

        yield* logger.info(
          `Registered ${jazzTools.length} tools from MCP server ${serverConfig.name}`,
        );
      }).pipe(
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            // Log error but continue with other servers
            const errorMessage = error instanceof Error ? error.message : String(error);
            yield* logger.warn(
              `Failed to register tools from MCP server ${serverConfig.name}: ${errorMessage}`,
            );
          }),
        ),
      );
    }
  });
}

/**
 * Register MCP server tools with lazy connection support
 *
 * This function uses a connect-get-disconnect pattern:
 * 1. Connect to each MCP server to discover available tools
 * 2. Immediately disconnect to prevent the CLI from hanging
 * 3. Register tools with server config for lazy reconnection when invoked
 *
 * @deprecated Use registerMCPToolsLazy() instead to avoid startup delays, or registerMCPToolsForSelection() for tool selection
 */
export function registerMCPTools(): Effect.Effect<
  void,
  Error,
  ToolRegistry | MCPServerManager | AgentConfigService | LoggerService | TerminalService
> {
  // Delegate to the new function to avoid code duplication
  return registerMCPToolsForSelection();
}

export const GMAIL_CATEGORY: ToolCategory = { id: "gmail", displayName: "Gmail" };
export const CALENDAR_CATEGORY: ToolCategory = { id: "calendar", displayName: "Calendar" };
export const HTTP_CATEGORY: ToolCategory = { id: "http", displayName: "HTTP" };
export const FILE_MANAGEMENT_CATEGORY: ToolCategory = {
  id: "file_management",
  displayName: "File Management",
};
export const SHELL_COMMANDS_CATEGORY: ToolCategory = {
  id: "shell_commands",
  displayName: "Shell Commands",
};
export const GIT_CATEGORY: ToolCategory = { id: "git", displayName: "Git" };
export const WEB_SEARCH_CATEGORY: ToolCategory = { id: "search", displayName: "Search" };
export const MCP_MONGODB_CATEGORY: ToolCategory = {
  id: "mcp_mongodb",
  displayName: "MongoDB (MCP)",
};

/**
 * Get MCP server names as tool categories without connecting to servers
 *
 * This allows showing MCP servers in tool selection UI without the overhead
 * of connecting to databases or other MCP servers just to show their names.
 *
 * @returns Record of MCP server category display names to empty tool arrays, and a map of display names to server names
 */
export function getMCPServerCategories(): Effect.Effect<
  {
    categories: Record<string, readonly string[]>;
    displayNameToServerName: Map<string, string>;
  },
  never,
  MCPServerManager | AgentConfigService
> {
  return Effect.gen(function* () {
    const mcpManager = yield* MCPServerManagerTag;
    const servers = yield* mcpManager.listServers();

    const categories: Record<string, string[]> = {};
    const displayNameToServerName = new Map<string, string>();

    for (const serverConfig of servers) {
      // Skip disabled servers
      if (serverConfig.enabled === false) {
        continue;
      }

      // Use the same category naming as registerMCPToolsForSelection
      const categoryDisplayName =
        serverConfig.name.toLowerCase() === "mongodb"
          ? MCP_MONGODB_CATEGORY.displayName
          : `${serverConfig.name} (MCP)`;

      // Add category with empty array (we don't know tool count without connecting)
      categories[categoryDisplayName] = [];
      // Map display name to server name for later tool registration
      displayNameToServerName.set(categoryDisplayName, serverConfig.name);
    }

    return { categories, displayNameToServerName };
  });
}

/**
 * All available tool categories
 */
export const ALL_CATEGORIES: readonly ToolCategory[] = [
  FILE_MANAGEMENT_CATEGORY,
  SHELL_COMMANDS_CATEGORY,
  GIT_CATEGORY,
  HTTP_CATEGORY,
  WEB_SEARCH_CATEGORY,
  GMAIL_CATEGORY,
  CALENDAR_CATEGORY,
  MCP_MONGODB_CATEGORY,
] as const;

/**
 * Create mappings between category display names and IDs
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

// Register Gmail tools
export function registerGmailTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const registerTool = registry.registerForCategory(GMAIL_CATEGORY);

    // Create Gmail tools
    const listEmailsTool = createListEmailsTool();
    const getEmailTool = createGetEmailTool();
    const searchEmailsTool = createSearchEmailsTool();
    const sendEmailTool = createSendEmailTool();
    const trashEmailTool = createTrashEmailTool();
    const deleteEmailTool = createDeleteEmailTool();

    // Create execution tools
    const executeTrashEmailTool = createExecuteTrashEmailTool();
    const executeDeleteEmailTool = createExecuteDeleteEmailTool();
    const executeDeleteLabelTool = createExecuteDeleteLabelTool();

    // Create Gmail label management tools
    const listLabelsTool = createListLabelsTool();
    const createLabelTool = createCreateLabelTool();
    const updateLabelTool = createUpdateLabelTool();
    const deleteLabelTool = createDeleteLabelTool();

    // Create Gmail email organization tools
    const addLabelsToEmailTool = createAddLabelsToEmailTool();
    const removeLabelsFromEmailTool = createRemoveLabelsFromEmailTool();
    const batchModifyEmailsTool = createBatchModifyEmailsTool();

    // Register Gmail tools
    yield* registerTool(listEmailsTool);
    yield* registerTool(getEmailTool);
    yield* registerTool(searchEmailsTool);
    yield* registerTool(sendEmailTool);
    yield* registerTool(trashEmailTool);
    yield* registerTool(deleteEmailTool);

    // Register execution tools
    yield* registerTool(executeTrashEmailTool);
    yield* registerTool(executeDeleteEmailTool);
    yield* registerTool(executeDeleteLabelTool);

    // Register Gmail label management tools
    yield* registerTool(listLabelsTool);
    yield* registerTool(createLabelTool);
    yield* registerTool(updateLabelTool);
    yield* registerTool(deleteLabelTool);

    // Register Gmail email organization tools
    yield* registerTool(addLabelsToEmailTool);
    yield* registerTool(removeLabelsFromEmailTool);
    yield* registerTool(batchModifyEmailsTool);
  });
}

// Register Calendar tools
export function registerCalendarTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const registerTool = registry.registerForCategory(CALENDAR_CATEGORY);

    // Register all calendar tools
    for (const tool of calendarTools) {
      yield* registerTool(tool);
    }
  });
}

// Register HTTP tools
export function registerHttpTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const registerTool = registry.registerForCategory(HTTP_CATEGORY);

    const httpRequestTool = createHttpRequestTool();

    yield* registerTool(httpRequestTool);
  });
}

// Register filesystem tools
export function registerFileTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const registerTool = registry.registerForCategory(FILE_MANAGEMENT_CATEGORY);

    const pwd = createPwdTool();
    const ls = createLsTool();
    const cd = createCdTool();
    const grep = createGrepTool();
    const readFile = createReadFileTool();
    const readPdf = createReadPdfTool();
    const head = createHeadTool();
    const tail = createTailTool();
    const find = createFindTool();
    const findPath = createFindPathTool();
    const stat = createStatTool();
    const mkdir = createMkdirTool();
    const executeMkdir = createExecuteMkdirTool();
    const rm = createRmTool();
    const executeRm = createExecuteRmTool();
    const writeFile = createWriteFileTool();
    const executeWriteFile = createExecuteWriteFileTool();
    const editFile = createEditFileTool();
    const executeEditFile = createExecuteEditFileTool();

    yield* registerTool(pwd);
    yield* registerTool(ls);
    yield* registerTool(cd);
    yield* registerTool(grep);
    yield* registerTool(readFile);
    yield* registerTool(readPdf);
    yield* registerTool(head);
    yield* registerTool(tail);
    yield* registerTool(writeFile);
    yield* registerTool(editFile);
    yield* registerTool(find);
    yield* registerTool(findPath);
    yield* registerTool(stat);
    yield* registerTool(mkdir);
    yield* registerTool(executeMkdir);
    yield* registerTool(rm);
    yield* registerTool(executeRm);
    yield* registerTool(executeWriteFile);
    yield* registerTool(executeEditFile);
  });
}

// Register shell command execution tools
export function registerShellTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const registerTool = registry.registerForCategory(SHELL_COMMANDS_CATEGORY);

    const executeCommandTool = createExecuteCommandTool();
    const executeCommandApprovedTool = createExecuteCommandApprovedTool();

    yield* registerTool(executeCommandTool);
    yield* registerTool(executeCommandApprovedTool);
  });
}

// Register Git tools
export function registerGitTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const registerTool = registry.registerForCategory(GIT_CATEGORY);

    // Safe Git operations (no approval needed)
    const gitStatusTool = createGitStatusTool();
    const gitLogTool = createGitLogTool();
    const gitDiffTool = createGitDiffTool();
    const gitBranchTool = createGitBranchTool();
    const gitTagTool = createGitTagTool();
    const gitBlameTool = createGitBlameTool();
    const gitReflogTool = createGitReflogTool();

    // Potentially destructive operations (approval required)
    const gitAddTool = createGitAddTool();
    const gitCommitTool = createGitCommitTool();
    const gitPushTool = createGitPushTool();
    const gitPullTool = createGitPullTool();
    const gitCheckoutTool = createGitCheckoutTool();
    const gitMergeTool = createGitMergeTool();

    // Internal execution tools (called after approval)
    const executeGitAddTool = createExecuteGitAddTool();
    const executeGitCommitTool = createExecuteGitCommitTool();
    const executeGitPushTool = createExecuteGitPushTool();
    const executeGitPullTool = createExecuteGitPullTool();
    const executeGitCheckoutTool = createExecuteGitCheckoutTool();
    const executeGitTagTool = createExecuteGitTagTool();
    const executeGitMergeTool = createExecuteGitMergeTool();

    // Register safe tools
    yield* registerTool(gitStatusTool);
    yield* registerTool(gitLogTool);
    yield* registerTool(gitDiffTool);
    yield* registerTool(gitBranchTool);
    yield* registerTool(gitTagTool);
    yield* registerTool(gitBlameTool);
    yield* registerTool(gitReflogTool);

    // Register approval-required tools
    yield* registerTool(gitAddTool);
    yield* registerTool(gitCommitTool);
    yield* registerTool(gitPushTool);
    yield* registerTool(gitPullTool);
    yield* registerTool(gitCheckoutTool);
    yield* registerTool(gitMergeTool);

    // Register internal execution tools
    yield* registerTool(executeGitAddTool);
    yield* registerTool(executeGitCommitTool);
    yield* registerTool(executeGitPushTool);
    yield* registerTool(executeGitPullTool);
    yield* registerTool(executeGitCheckoutTool);
    yield* registerTool(executeGitTagTool);
    yield* registerTool(executeGitMergeTool);
  });
}

// Register web search tools
export function registerSearchTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const registerTool = registry.registerForCategory(WEB_SEARCH_CATEGORY);

    const webSearchTool = createWebSearchTool();

    yield* registerTool(webSearchTool);
  });
}

/**
 * Create a layer that registers all tools including MCP tools
 *
 * Requires:
 * - ToolRegistry: For registering tools
 * - MCPServerManager: For MCP server connections
 * - AgentConfigService: For configuration access
 * - LoggerService: For logging
 * - TerminalService: For user prompts during MCP setup
 */
export function createToolRegistrationLayer(): Layer.Layer<
  never,
  Error,
  MCPRegistrationDependencies
> {
  return Layer.effectDiscard(registerAllTools());
}
