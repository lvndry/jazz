import { Effect, Layer } from "effect";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import React from "react";
import type { AgentConfigService } from "@/core/interfaces/agent-config";
import type { LoggerService } from "@/core/interfaces/logger";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import type { MCPServerManager } from "@/core/interfaces/mcp-server";
import { MCPServerManagerTag } from "@/core/interfaces/mcp-server";
import type { TerminalService } from "@/core/interfaces/terminal";
import { ink, TerminalServiceTag } from "@/core/interfaces/terminal";
import type { ToolRegistry } from "@/core/interfaces/tool-registry";
import { ToolRegistryTag } from "@/core/interfaces/tool-registry";
import type { ToolCategory } from "@/core/types";
import type { MCPTool } from "@/core/types/mcp";
import { toPascalCase } from "@/core/utils/string";
import { calendar } from "./calendar";
import { createContextInfoTool } from "./context-tools";
import { fs } from "./fs";
import { git } from "./git";
import { gmail } from "./gmail";
import { createHttpRequestTool } from "./http-tools";
import { registerMCPServerTools } from "./mcp-tools";
import { createShellCommandTools } from "./shell-tools";
import { skillTools } from "./skill-tools";
import { userInteractionTools } from "./user-interaction-tools";
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
    yield* registerSkillSystemTools();
    yield* registerContextTools();
    yield* registerUserInteractionTools();
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
 * Connects only to MCP servers that the agent actually uses based on its tool list.
 * Returns the list of connected server names for cleanup when the conversation ends.
 *
 * @param agentToolNames - The list of tool names the agent uses
 * @returns Array of connected MCP server names
 */
export function registerMCPToolsForAgent(
  agentToolNames: readonly string[],
): Effect.Effect<
  readonly string[],
  Error,
  ToolRegistry | MCPServerManager | AgentConfigService | LoggerService | TerminalService
> {
  return Effect.gen(function* () {
    const mcpManager = yield* MCPServerManagerTag;
    const registry = yield* ToolRegistryTag;
    const logger = yield* LoggerServiceTag;

    // Extract MCP tool names (format: mcp_<servername>_<toolname>)
    const mcpToolNames = agentToolNames.filter((name) => name.startsWith("mcp_"));

    // If agent has no MCP tools, skip connection entirely
    if (mcpToolNames.length === 0) {
      yield* logger.debug("Agent has no MCP tools, skipping MCP server connections");
      return [];
    }

    // Get all configured MCP servers
    const allServers = yield* mcpManager.listServers();

    yield* logger.debug(
      `Found ${allServers.length} configured MCP server(s): ${allServers.map((s) => s.name).join(", ")}`,
    );

    // Extract server names that the agent actually uses from its tool list
    // Match tool names to known servers by prefix
    // This handles cases where tool names contain underscores (e.g. mcp_server_tool_name)
    // and avoids ambiguity in parsing
    const requiredServerNames = new Set<string>();
    for (const server of allServers) {
      const prefix = `mcp_${server.name.toLowerCase()}_`;
      if (mcpToolNames.some((name) => name.startsWith(prefix))) {
        requiredServerNames.add(server.name);
      }
    }

    if (requiredServerNames.size > 0) {
      yield* logger.debug(
        `Agent uses tools from ${requiredServerNames.size} MCP server(s): ${Array.from(requiredServerNames).map(toPascalCase).join(", ")}`,
      );
    }

    // Connect only to enabled servers that the agent actually uses
    // This avoids unnecessary connections and improves startup performance
    const serversToConnect = allServers.filter(
      (server) =>
        server.enabled !== false &&
        requiredServerNames.has(server.name)
    );

    if (serversToConnect.length === 0) {
      yield* logger.debug("No MCP servers to connect to for this agent");
      return [];
    }

    yield* logger.debug(
      `Connecting to ${serversToConnect.length} MCP server(s) required by agent during setup`,
    );

    // Track successfully connected servers for cleanup
    const connectedServers: string[] = [];

    // Connect to and register tools from required servers
    // Credentials are validated early for servers the agent uses
    for (const serverConfig of serversToConnect) {
      // Skip disabled servers
      if (serverConfig.enabled === false) {
        yield* logger.debug(`Skipping disabled MCP server: ${serverConfig.name}`);
        continue;
      }

      yield* Effect.gen(function* () {
        const terminal = yield* TerminalServiceTag;
        const serverName = serverConfig.name;

        // Check if server is already connected to avoid showing duplicate connection messages
        const isAlreadyConnected = yield* mcpManager.isConnected(serverName);

        let logId: string | undefined;
        if (!isAlreadyConnected) {
          // Generate a unique ID for this connection log entry
          logId = `mcp-connecting-${serverName}-${Date.now()}`;

          // Show connecting message with spinner only if not already connected
          yield* terminal.log(
            ink(
              React.createElement(
                Box,
                {},
                React.createElement(Text, { color: "cyan" }, [
                  React.createElement(Spinner, { key: "spinner", type: "dots" }),
                ]),
                React.createElement(Text, {}, ` Connecting to ${toPascalCase(serverName)} MCP server...`),
              ),
            ),
            logId,
          );

          yield* logger.debug(`Connecting to MCP server ${serverName}...`);
        } else {
          yield* logger.debug(`MCP server ${serverName} already connected, skipping connection UI`);
        }

        // Connect to server and maintain connection (don't disconnect after discovery)
        // This ensures tools are available when needed and connections persist during the session
        // If connection fails (e.g., invalid credentials), we show a clear message but continue
        const connectResult = yield* Effect.either(mcpManager.connectServer(serverConfig));
        if (connectResult._tag === "Left") {
          const error = connectResult.left;
          const errorMessage = String(error);

          // Check if this looks like an authentication/credential error
          const isAuthError =
            errorMessage.toLowerCase().includes("auth") ||
            errorMessage.toLowerCase().includes("credential") ||
            errorMessage.toLowerCase().includes("api key") ||
            errorMessage.toLowerCase().includes("invalid") ||
            errorMessage.toLowerCase().includes("unauthorized") ||
            errorMessage.toLowerCase().includes("401") ||
            errorMessage.toLowerCase().includes("403");

          // Update log to show error with helpful context (only if we showed connection UI)
          if (logId !== undefined) {
            const errorPrefix = isAuthError
              ? `✗ ${toPascalCase(serverName)} MCP unavailable (invalid credentials)`
              : `✗ Failed to connect to ${toPascalCase(serverName)} MCP server`;

            yield* terminal.updateLog(
              logId,
              ink(
                React.createElement(Text, { color: "yellow" }, errorPrefix),
              ),
            );

            if (isAuthError) {
              yield* terminal.updateLog(
                logId,
                ink(
                  React.createElement(
                    Box,
                    { marginTop: 1 },
                    React.createElement(Text, { color: "gray" }, `   The agent will continue without ${toPascalCase(serverName)} tools.`),
                  ),
                ),
              );
            }
          }

          if (isAuthError) {
            yield* logger.warn(
              `MCP server ${serverName} connection failed due to invalid credentials: ${errorMessage}`,
            );
          } else {
            yield* logger.error(`Failed to connect to MCP server ${serverName}: ${errorMessage}`);
          }

          // Skip this server but continue with others
          return;
        }

        // Get tools from the connected server
        const mcpToolsResult = yield* Effect.either(mcpManager.getServerTools(serverName));
        let mcpTools: readonly MCPTool[];
        if (mcpToolsResult._tag === "Right") {
          mcpTools = mcpToolsResult.right;
        } else {
          const error = mcpToolsResult.left;
          const errorMessage = String(error);
          if (logId !== undefined) {
            yield* terminal.updateLog(
              logId,
              ink(
                React.createElement(Text, { color: "yellow" }, `✗ Failed to discover tools from ${toPascalCase(serverName)} MCP server`),
              ),
            );
            yield* terminal.updateLog(
              logId,
              ink(
                React.createElement(
                  Box,
                  { marginTop: 1 },
                  React.createElement(Text, { color: "gray" }, `   The agent will continue without ${toPascalCase(serverName)} tools.`),
                ),
              ),
            );
          }
          yield* logger.warn(`Failed to discover tools from MCP server ${serverName}: ${errorMessage}`);
          // Return empty array on error - tools won't be available, but we continue
          mcpTools = [];
        }

        yield* logger.debug(`Discovered ${mcpTools.length} tool(s) from MCP server ${serverName}`);

        // Update the log entry to show success (replaces spinner) - only if we showed connection UI
        if (logId !== undefined && !isAlreadyConnected) {
          yield* terminal.updateLog(
            logId,
            ink(
              React.createElement(Text, { color: "green" }, `✓ Successfully connected to ${toPascalCase(serverName)} MCP server`),
            ),
          );
        }

        // Determine category for tools
        const category: ToolCategory = {
          id: `mcp_${serverConfig.name.toLowerCase()}`,
          displayName: `${toPascalCase(serverConfig.name)} (MCP)`,
        };

        // Register tools with server config for lazy reconnection
        // Agents always use all tools from their selected MCP servers, so register all discovered tools
        const registerTool = registry.registerForCategory(category);
        const jazzTools = yield* registerMCPServerTools(serverConfig, mcpTools);

        // Register all tools from this MCP server (agents use all tools from selected MCPs)
        const registeredToolNames: string[] = [];
        for (const tool of jazzTools) {
          yield* registerTool(tool);
          registeredToolNames.push(tool.name);
        }

        if (registeredToolNames.length > 0) {
          yield* logger.info(
            `Registered ${registeredToolNames.length} MCP tool(s) from ${serverConfig.name}: ${registeredToolNames.join(", ")}`,
          );
          // Track this server as successfully connected
          connectedServers.push(serverConfig.name);
        } else {
          yield* logger.debug(
            `MCP server ${serverConfig.name} connected but no tools were discovered`,
          );
        }
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

    return connectedServers;
  }).pipe(Effect.mapError((error: unknown) => (error instanceof Error ? error : new Error(String(error)))));
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
        const category: ToolCategory = {
          id: `mcp_${serverConfig.name.toLowerCase()}`,
          displayName: `${toPascalCase(serverConfig.name)} (MCP)`,
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
export const SKILLS_CATEGORY: ToolCategory = { id: "skills", displayName: "Skills" };
export const CONTEXT_CATEGORY: ToolCategory = { id: "context", displayName: "Context" };
export const USER_INTERACTION_CATEGORY: ToolCategory = { id: "user_interaction", displayName: "User Interaction" };

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
      const categoryDisplayName = `${toPascalCase(serverConfig.name)} (MCP)`;

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
  SKILLS_CATEGORY,
  CONTEXT_CATEGORY,
  USER_INTERACTION_CATEGORY,
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

    // Read-only tools (no approval needed)
    yield* registerTool(gmail.listEmails());
    yield* registerTool(gmail.getEmail());
    yield* registerTool(gmail.searchEmails());
    yield* registerTool(gmail.sendEmail());
    yield* registerTool(gmail.listLabels());
    yield* registerTool(gmail.createLabel());
    yield* registerTool(gmail.updateLabel());
    yield* registerTool(gmail.addLabels());
    yield* registerTool(gmail.removeLabels());
    yield* registerTool(gmail.batchModify());

    // Approval-required tools - each returns { approval, execute }
    const trashTools = gmail.trashEmail();
    yield* registerTool(trashTools.approval);
    yield* registerTool(trashTools.execute);

    const deleteEmailTools = gmail.deleteEmail();
    yield* registerTool(deleteEmailTools.approval);
    yield* registerTool(deleteEmailTools.execute);

    const deleteLabelTools = gmail.deleteLabel();
    yield* registerTool(deleteLabelTools.approval);
    yield* registerTool(deleteLabelTools.execute);
  });
}

// Register Calendar tools
export function registerCalendarTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const registerTool = registry.registerForCategory(CALENDAR_CATEGORY);

    // Read-only tools (no approval needed)
    yield* registerTool(calendar.listEvents());
    yield* registerTool(calendar.getEvent());
    yield* registerTool(calendar.searchEvents());
    yield* registerTool(calendar.listCalendars());
    yield* registerTool(calendar.getUpcoming());

    // Write tools (approval required) - each returns { approval, execute }
    const createTools = calendar.createEvent();
    yield* registerTool(createTools.approval);
    yield* registerTool(createTools.execute);

    const updateTools = calendar.updateEvent();
    yield* registerTool(updateTools.approval);
    yield* registerTool(updateTools.execute);

    const deleteTools = calendar.deleteEvent();
    yield* registerTool(deleteTools.approval);
    yield* registerTool(deleteTools.execute);

    const quickAddTools = calendar.quickAdd();
    yield* registerTool(quickAddTools.approval);
    yield* registerTool(quickAddTools.execute);
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

    // Navigation tools
    yield* registerTool(fs.pwd());
    yield* registerTool(fs.ls());
    yield* registerTool(fs.cd());
    yield* registerTool(fs.stat());

    // Read tools
    yield* registerTool(fs.read());
    yield* registerTool(fs.readPdf());
    yield* registerTool(fs.head());
    yield* registerTool(fs.tail());

    // Search tools
    yield* registerTool(fs.grep());
    yield* registerTool(fs.find());
    yield* registerTool(fs.findPath());

    // Write tools (approval required) - each returns { approval, execute }
    const writeTools = fs.write();
    yield* registerTool(writeTools.approval);
    yield* registerTool(writeTools.execute);

    const editTools = fs.edit();
    yield* registerTool(editTools.approval);
    yield* registerTool(editTools.execute);

    const mkdirTools = fs.mkdir();
    yield* registerTool(mkdirTools.approval);
    yield* registerTool(mkdirTools.execute);

    const rmTools = fs.rm();
    yield* registerTool(rmTools.approval);
    yield* registerTool(rmTools.execute);
  });
}

// Register shell command execution tools
export function registerShellTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const registerTool = registry.registerForCategory(SHELL_COMMANDS_CATEGORY);

    const shellTools = createShellCommandTools();
    yield* registerTool(shellTools.approval);
    yield* registerTool(shellTools.execute);
  });
}

// Register Git tools
export function registerGitTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const registerTool = registry.registerForCategory(GIT_CATEGORY);

    // Safe Git operations (no approval needed)
    yield* registerTool(git.status());
    yield* registerTool(git.log());
    yield* registerTool(git.diff());
    yield* registerTool(git.branch());
    yield* registerTool(git.blame());
    yield* registerTool(git.reflog());
    yield* registerTool(git.tagList());

    // Approval-required operations - each returns { approval, execute }
    const addTools = git.add();
    yield* registerTool(addTools.approval);
    yield* registerTool(addTools.execute);

    const commitTools = git.commit();
    yield* registerTool(commitTools.approval);
    yield* registerTool(commitTools.execute);

    const pushTools = git.push();
    yield* registerTool(pushTools.approval);
    yield* registerTool(pushTools.execute);

    const pullTools = git.pull();
    yield* registerTool(pullTools.approval);
    yield* registerTool(pullTools.execute);

    const checkoutTools = git.checkout();
    yield* registerTool(checkoutTools.approval);
    yield* registerTool(checkoutTools.execute);

    const mergeTools = git.merge();
    yield* registerTool(mergeTools.approval);
    yield* registerTool(mergeTools.execute);

    const rmTools = git.rm();
    yield* registerTool(rmTools.approval);
    yield* registerTool(rmTools.execute);

    const tagTools = git.tag();
    yield* registerTool(tagTools.approval);
    yield* registerTool(tagTools.execute);
  });
}

// Register web search tools
export function registerSearchTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const registerTool = registry.registerForCategory(WEB_SEARCH_CATEGORY);

    const webSearchTool = createWebSearchTool();

    yield* registerTool(webSearchTool);
    yield* registerTool(webSearchTool);
  });
}

export function registerSkillSystemTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const registerTool = registry.registerForCategory(SKILLS_CATEGORY);

    for (const tool of skillTools) {
      yield* registerTool(tool);
    }
  });
}

// Register context awareness tools
export function registerContextTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const registerTool = registry.registerForCategory(CONTEXT_CATEGORY);

    yield* registerTool(createContextInfoTool());
  });
}

// Register user interaction tools (ask_user)
export function registerUserInteractionTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const registerTool = registry.registerForCategory(USER_INTERACTION_CATEGORY);

    for (const tool of userInteractionTools) {
      yield* registerTool(tool);
    }
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
