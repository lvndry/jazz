import { Cause, Effect } from "effect";
import type { AgentConfigService } from "@/core/interfaces/agent-config";
import type { LoggerService } from "@/core/interfaces/logger";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import type { MCPServerConfig, MCPServerManager } from "@/core/interfaces/mcp-server";
import { MCPServerManagerTag } from "@/core/interfaces/mcp-server";
import type { PresentationService } from "@/core/interfaces/presentation";
import { PresentationServiceTag } from "@/core/interfaces/presentation";
import type { TerminalService } from "@/core/interfaces/terminal";
import type { Tool, ToolRegistry } from "@/core/interfaces/tool-registry";
import { ToolRegistryTag } from "@/core/interfaces/tool-registry";
import type { MCPTool } from "@/core/types/mcp";
import { isAuthenticationRequired } from "@/core/utils/mcp";
import { toPascalCase } from "@/core/utils/string";
import { buildResourceTools, registerMCPServerTools, type MCPToolDependencies } from "./mcp-tools";
import { mcpToolCategory } from "./tool-categories";

/**
 * What is currently registered from each MCP server, so a `list_changed`
 * notification can add new tools and retire ones the server dropped.
 *
 * Module-scoped because the tool registry and server manager are both
 * process-wide singletons; a per-call structure would re-subscribe on every
 * conversation and leak handlers.
 */
const registeredServers = new Map<
  string,
  {
    readonly config: MCPServerConfig;
    readonly hasResources: boolean;
    toolNames: readonly string[];
  }
>();

/** Set once the manager-level `list_changed` subscription is installed. */
let toolsChangedSubscribed = false;

/** Register a server's tools, retiring any the server no longer advertises. */
function syncServerTools(
  registry: ToolRegistry,
  serverConfig: MCPServerConfig,
  mcpTools: readonly MCPTool[],
  hasResources: boolean,
): Effect.Effect<readonly string[], never> {
  return Effect.gen(function* () {
    const category = mcpToolCategory(serverConfig.name);
    const registerTool = registry.registerForCategory(category);

    const jazzTools = yield* registerMCPServerTools(serverConfig, mcpTools).pipe(
      Effect.catchAll(() => Effect.succeed([] as readonly Tool<MCPToolDependencies>[])),
    );

    // A server's own tool names win a collision: the resource pair is Jazz's
    // addition, and shadowing something the server actually advertises would
    // be worse than going without.
    const advertised = new Set(jazzTools.map((tool) => tool.name));
    const resourceTools = hasResources
      ? buildResourceTools(serverConfig).filter((tool) => !advertised.has(tool.name))
      : [];

    const nextNames: string[] = [];
    for (const tool of [...jazzTools, ...resourceTools]) {
      yield* registerTool(tool);
      nextNames.push(tool.name);
    }

    const previous = registeredServers.get(serverConfig.name)?.toolNames ?? [];
    const nextNameSet = new Set(nextNames);
    for (const staleName of previous) {
      if (!nextNameSet.has(staleName)) {
        yield* registry.unregisterTool(staleName);
      }
    }

    registeredServers.set(serverConfig.name, {
      config: serverConfig,
      hasResources,
      toolNames: nextNames,
    });

    // Only the model-facing half of each approval pair is worth reporting; the
    // hidden `execute_*` twin is an implementation detail.
    return nextNames.filter((name) => !name.startsWith("execute_"));
  });
}

/**
 * Install the one-time subscription that keeps the registry in step with
 * servers that re-advertise their tools mid-session.
 */
function subscribeToToolChanges(): Effect.Effect<
  void,
  never,
  MCPServerManager | ToolRegistry | LoggerService
> {
  return Effect.gen(function* () {
    if (toolsChangedSubscribed) return;

    const mcpManager = yield* MCPServerManagerTag;
    const registry = yield* ToolRegistryTag;
    const logger = yield* LoggerServiceTag;

    yield* mcpManager.onToolsChanged((serverName, tools) => {
      const entry = registeredServers.get(serverName);
      if (!entry) return;

      void Effect.runPromise(
        syncServerTools(registry, entry.config, tools, entry.hasResources).pipe(
          Effect.tap((names) =>
            logger.info(
              `MCP server ${serverName} changed its tool list; now ${names.length} tool(s)`,
            ),
          ),
          Effect.catchAllCause(() => Effect.void),
        ),
      );
    });

    toolsChangedSubscribed = true;
  });
}

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

    const mcpToolNames = agentToolNames.filter((name) => name.startsWith("mcp_"));

    if (mcpToolNames.length === 0) {
      yield* logger.debug("Agent has no MCP tools, skipping MCP server connections");
      return [];
    }

    const allServers = yield* mcpManager.listServers();

    yield* logger.debug(
      `Found ${allServers.length} configured MCP server(s): ${allServers.map((server) => server.name).join(", ")}`,
    );

    // Match tool names to servers by prefix rather than by splitting the name:
    // both the server name and the tool name may contain underscores.
    const requiredServerNames = new Set<string>();
    for (const server of allServers) {
      const prefix = `mcp_${server.name.toLowerCase()}_`;
      if (mcpToolNames.some((name) => name.startsWith(prefix))) {
        requiredServerNames.add(server.name);
      }
    }

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

    yield* subscribeToToolChanges();

    const connectedServers: string[] = [];

    for (const serverConfig of serversToConnect) {
      yield* Effect.gen(function* () {
        const presentation = yield* PresentationServiceTag;
        const serverName = serverConfig.name;

        const isAlreadyConnected = yield* mcpManager.isConnected(serverName);

        const showedConnectionUI = !isAlreadyConnected;
        if (showedConnectionUI) {
          yield* presentation.presentStatus(
            `Connecting to ${toPascalCase(serverName)} MCP server...`,
            "progress",
          );
          yield* logger.debug(`Connecting to MCP server ${serverName}...`);
        }

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
          const isAuthError = isAuthenticationRequired(error.reason);

          if (showedConnectionUI) {
            yield* presentation.presentStatus(
              isAuthError
                ? `${toPascalCase(serverName)} MCP unavailable (authorization required)`
                : `Failed to connect to ${toPascalCase(serverName)} MCP server`,
              "warning",
            );
            if (error.suggestion) {
              yield* presentation.presentStatus(error.suggestion, "info");
            }
            yield* presentation.presentStatus(
              `The agent will continue without ${toPascalCase(serverName)} tools.`,
              "info",
            );
          }

          if (isAuthError) {
            yield* logger.warn(
              `MCP server ${serverName} connection failed due to authorization: ${error.reason}`,
            );
          } else {
            yield* logger.error(`Failed to connect to MCP server ${serverName}: ${error.reason}`);
          }

          return;
        }

        const mcpToolsResult = yield* Effect.either(mcpManager.getServerTools(serverName));
        let mcpTools: readonly MCPTool[] = [];
        if (mcpToolsResult._tag === "Right") {
          mcpTools = mcpToolsResult.right;
        } else {
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
            `Failed to discover tools from MCP server ${serverName}: ${mcpToolsResult.left.reason}`,
          );
        }

        yield* logger.debug(`Discovered ${mcpTools.length} tool(s) from MCP server ${serverName}`);

        if (showedConnectionUI) {
          yield* presentation.presentStatus(
            `Connected to ${toPascalCase(serverName)} MCP server`,
            "success",
          );
        }

        // Only worth adding the resource tools when the server actually
        // advertised the capability; otherwise they would always fail.
        const capabilities = yield* mcpManager.getCapabilities(serverName);
        const hasResources = capabilities?.resources !== undefined;

        const registeredToolNames = yield* syncServerTools(
          registry,
          serverConfig,
          mcpTools,
          hasResources,
        );

        if (registeredToolNames.length > 0) {
          yield* logger.info(
            `Registered ${registeredToolNames.length} MCP tool(s) from ${serverConfig.name}: ${registeredToolNames.join(", ")}`,
          );
          connectedServers.push(serverConfig.name);
        } else {
          yield* logger.debug(
            `MCP server ${serverConfig.name} connected but no tools were discovered`,
          );
        }
      }).pipe(
        // Every failure inside is already turned into an Either above, so only
        // a defect can land here. One broken server must not abort the rest.
        Effect.catchAllCause((cause) =>
          logger.warn(
            `Failed to register tools from MCP server ${serverConfig.name}: ${Cause.pretty(cause)}`,
          ),
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

    const categories: Record<string, readonly string[]> = {};
    const displayNameToServerName = new Map<string, string>();

    for (const serverConfig of servers) {
      if (serverConfig.enabled === false) continue;

      const category = mcpToolCategory(serverConfig.name);
      categories[category.displayName] = [];
      displayNameToServerName.set(category.displayName, serverConfig.name);
    }

    return { categories, displayNameToServerName };
  });
}
