import { Effect } from "effect";
import type { AgentConfigService } from "@/core/interfaces/agent-config";
import type { LoggerService } from "@/core/interfaces/logger";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import type { MCPServerManager } from "@/core/interfaces/mcp-server";
import { MCPServerManagerTag } from "@/core/interfaces/mcp-server";
import type { PresentationService } from "@/core/interfaces/presentation";
import { PresentationServiceTag } from "@/core/interfaces/presentation";
import type { TerminalService } from "@/core/interfaces/terminal";
import type { ToolRegistry } from "@/core/interfaces/tool-registry";
import { ToolRegistryTag } from "@/core/interfaces/tool-registry";
import type { MCPTool } from "@/core/types/mcp";
import { toPascalCase } from "@/core/utils/string";
import { registerMCPServerTools } from "./mcp-tools";
import { mcpToolCategory } from "./tool-categories";

/**
 * Register MCP tools for a specific agent based on their tool requirements.
 *
 * Connects only to MCP servers that the agent actually uses based on its tool list.
 * Returns the list of connected server names for cleanup when the conversation ends.
 *
 * MCP servers connect on first use rather than at CLI startup so a hung child
 * process cannot stall `jazz`.
 *
 * @param agentToolNames - The list of tool names the agent uses
 * @returns Array of connected MCP server names
 */
export function registerMCPToolsForAgent(
  agentToolNames: readonly string[],
): Effect.Effect<
  readonly string[],
  Error,
  | ToolRegistry
  | MCPServerManager
  | AgentConfigService
  | LoggerService
  | TerminalService
  | PresentationService
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
      (server) => server.enabled !== false && requiredServerNames.has(server.name),
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
        const presentation = yield* PresentationServiceTag;
        const serverName = serverConfig.name;

        // Check if server is already connected to avoid showing duplicate connection messages
        const isAlreadyConnected = yield* mcpManager.isConnected(serverName);

        let showedConnectionUI = false;
        if (!isAlreadyConnected) {
          showedConnectionUI = true;

          // Show connecting message only if not already connected
          yield* presentation.presentStatus(
            `Connecting to ${toPascalCase(serverName)} MCP server...`,
            "progress",
          );

          yield* logger.debug(`Connecting to MCP server ${serverName}...`);
        } else {
          yield* logger.debug(`MCP server ${serverName} already connected, skipping connection UI`);
        }

        // Connect to server and maintain connection (don't disconnect after discovery)
        // This ensures tools are available when needed and connections persist during the session
        // If connection fails (e.g., invalid credentials), we show a clear message but continue
        const connectResult = yield* Effect.either(mcpManager.connectServer(serverConfig));
        // Tell the interface whether this connector is actually reachable. A
        // failure here is not fatal — the agent carries on without those tools —
        // so the header is the only place the user would otherwise learn of it.
        if (presentation.reportConnector) {
          yield* presentation.reportConnector(
            serverName,
            connectResult._tag === "Left" ? "offline" : "live",
          );
        }
        if (connectResult._tag === "Left") {
          const error = connectResult.left;
          const errorMessage = String(error);

          const isAuthError = isMcpAuthError(errorMessage);

          // Show error with helpful context (only if we showed connection UI)
          if (showedConnectionUI) {
            const errorPrefix = isAuthError
              ? `${toPascalCase(serverName)} MCP unavailable (invalid credentials)`
              : `Failed to connect to ${toPascalCase(serverName)} MCP server`;

            yield* presentation.presentStatus(errorPrefix, "warning");

            if (isAuthError) {
              yield* presentation.presentStatus(
                `The agent will continue without ${toPascalCase(serverName)} tools.`,
                "info",
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
          if (showedConnectionUI) {
            yield* presentation.presentStatus(
              `Failed to discover tools from ${toPascalCase(serverName)} MCP server`,
              "warning",
            );
            yield* presentation.presentStatus(
              `The agent will continue without ${toPascalCase(serverName)} tools.`,
              "info",
            );
          }
          yield* logger.warn(
            `Failed to discover tools from MCP server ${serverName}: ${errorMessage}`,
          );
          // Return empty array on error - tools won't be available, but we continue
          mcpTools = [];
        }

        yield* logger.debug(`Discovered ${mcpTools.length} tool(s) from MCP server ${serverName}`);

        // Show success - only if we showed connection UI
        if (showedConnectionUI) {
          yield* presentation.presentStatus(
            `Connected to ${toPascalCase(serverName)} MCP server`,
            "success",
          );
        }

        const category = mcpToolCategory(serverConfig.name);

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
  }).pipe(
    Effect.mapError((error: unknown) =>
      error instanceof Error ? error : new Error(String(error)),
    ),
  );
}

/**
 * Get MCP server names as tool categories without connecting to servers.
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

      const category = mcpToolCategory(serverConfig.name);

      // Add category with empty array (we don't know tool count without connecting)
      categories[category.displayName] = [];
      // Map display name to server name for later tool registration
      displayNameToServerName.set(category.displayName, serverConfig.name);
    }

    return { categories, displayNameToServerName };
  });
}

function isMcpAuthError(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase();
  return (
    lower.includes("auth") ||
    lower.includes("credential") ||
    lower.includes("api key") ||
    lower.includes("invalid") ||
    lower.includes("unauthorized") ||
    lower.includes("401") ||
    lower.includes("403")
  );
}
