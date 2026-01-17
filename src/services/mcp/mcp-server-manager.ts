import { createMCPClient } from "@ai-sdk/mcp";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Effect, Layer } from "effect";
import type { AgentConfigService } from "../../core/interfaces/agent-config";
import { AgentConfigServiceTag } from "../../core/interfaces/agent-config";
import type { LoggerService } from "../../core/interfaces/logger";
import { LoggerServiceTag } from "../../core/interfaces/logger";
import type {
  MCPServerConfig,
  MCPServerConnection,
  MCPServerManager,
} from "../../core/interfaces/mcp-server";
import { MCPServerManagerTag } from "../../core/interfaces/mcp-server";
import type { TerminalService } from "../../core/interfaces/terminal";
import { TerminalServiceTag } from "../../core/interfaces/terminal";
import {
  MCPConnectionError,
  MCPDisconnectionError,
  MCPToolDiscoveryError,
} from "../../core/types/errors";
import type { MCPClient, MCPTool } from "../../core/types/mcp";
import {
  isMCPClient,
  normalizeMCPToolRegistry,
} from "../../core/types/mcp";
import { createSanitizedEnv } from "../../core/utils/env-utils";
import { retryWithBackoff } from "../../core/utils/mcp-utils";

/**
 * MCP Server Manager implementation
 *
 * Manages connections to MCP servers using stdio transport.
 * Handles template variable resolution, process lifecycle, and tool discovery.
 */
class MCPServerManagerImpl implements MCPServerManager {
  private connections: Map<string, MCPServerConnection>;
  private logger: LoggerService;

  constructor(logger: LoggerService) {
    this.connections = new Map();
    this.logger = logger;
  }

  connectServer(
    config: MCPServerConfig,
  ): Effect.Effect<
    MCPClient,
    MCPConnectionError,
    LoggerService | AgentConfigService | TerminalService
  > {
    // Capture this to avoid issues with Effect.gen not preserving context
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const manager = this;
    return Effect.gen(function* () {
      // Check if already connected
      const existing = manager.connections.get(config.name);
      if (existing && existing.client) {
        yield* manager.logger.debug(`MCP server ${config.name} already connected`);
        return existing.client;
      }

      yield* manager.logger.debug(`Connecting to MCP server: ${config.name}`);

      // Resolve template variables
      const resolvedArgs = yield* manager.resolveTemplateVariables(config).pipe(
        Effect.mapError((error) => {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return new MCPConnectionError({
            serverName: config.name,
            reason: `Failed to resolve template variables: ${errorMessage}`,
            cause: error,
            suggestion: `Check the MCP server configuration and ensure all required inputs are provided`,
          });
        }),
      );

      // Create sanitized environment
      const sanitizedEnv = createSanitizedEnv(config.env || {});

      // Create stdio transport
      const transport = new StdioClientTransport({
        command: config.command,
        args: [...resolvedArgs], // Convert readonly array to mutable
        env: sanitizedEnv as Record<string, string>, // Type assertion for env
      });

      // Create MCP client with retry logic for transient failures
      const connectEffect = Effect.promise(() => createMCPClient({ transport })).pipe(
        Effect.map((client) => {
          if (!isMCPClient(client)) {
            throw new Error(`Invalid MCP client returned from createMCPClient`);
          }
          return client;
        }),
      );

      const client = yield* retryWithBackoff(connectEffect, {
        maxRetries: 3,
        initialDelayMs: 1000,
        maxDelayMs: 10000,
        shouldRetry: (error: unknown) => {
          // Retry on connection errors, but not on validation errors
          const errorMessage = error instanceof Error ? error.message : String(error);
          return (
            errorMessage.includes("ECONNREFUSED") ||
            errorMessage.includes("ETIMEDOUT") ||
            errorMessage.includes("timeout") ||
            errorMessage.includes("connection")
          );
        },
      }).pipe(
        Effect.mapError((error: unknown) => {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return new MCPConnectionError({
            serverName: config.name,
            reason: `Failed to connect to MCP server: ${errorMessage}`,
            cause: error,
            suggestion: `Check that the command "${config.command}" is available and the server is configured correctly`,
          });
        }),
      );

      // Store connection (process is managed by transport)
      const connection: MCPServerConnection = {
        serverName: config.name,
        process: null, // Process is managed internally by StdioClientTransport
        client,
        transport,
      };

      manager.connections.set(config.name, connection);

      yield* manager.logger.info(`Connected to MCP server: ${config.name}`);

      return client;
    }).pipe(
      Effect.mapError((error: unknown) => {
        // Catch any remaining errors and convert to MCPConnectionError
        if (error instanceof MCPConnectionError) {
          return error;
        }
        const errorMessage = error instanceof Error ? error.message : String(error);
        return new MCPConnectionError({
          serverName: config.name,
          reason: `Unexpected error during connection: ${errorMessage}`,
          cause: error,
          suggestion: `Check the MCP server configuration and logs for more details`,
        });
      }),
    );
  }

  disconnectServer(
    serverName: string,
  ): Effect.Effect<void, MCPDisconnectionError, LoggerService> {
    // Capture this to avoid issues with Effect.gen not preserving context
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const manager = this;
    return Effect.gen(function* () {
      const connection = manager.connections.get(serverName);
      if (!connection) {
        yield* manager.logger.debug(`MCP server ${serverName} not connected`);
        return;
      }

      try {
        // Close the client if it has a close method
        if (connection.client.close) {
          yield* Effect.promise(() => connection.client.close!()).pipe(
            Effect.catchAll((error: unknown) =>
              Effect.gen(function* () {
                const errorMessage = error instanceof Error ? error.message : String(error);
                yield* manager.logger.warn(
                  `Error closing MCP client for ${serverName}: ${errorMessage}`,
                );
                // Continue with cleanup even if close fails
              }),
            ),
          );
        }

        // Transport cleanup is handled by the SDK
        manager.connections.delete(serverName);
        yield* manager.logger.info(`Disconnected from MCP server: ${serverName}`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        manager.connections.delete(serverName); // Still remove from connections
        return yield* Effect.fail(
          new MCPDisconnectionError({
            serverName,
            reason: `Error disconnecting from MCP server: ${errorMessage}`,
            suggestion: "The connection has been removed from the manager, but cleanup may be incomplete",
          }),
        );
      }
    });
  }

  getServerTools(
    serverName: string,
  ): Effect.Effect<readonly MCPTool[], MCPToolDiscoveryError, LoggerService> {
    // Capture this to avoid issues with Effect.gen not preserving context
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const manager = this;
    return Effect.gen(function* () {
      const connection = manager.connections.get(serverName);
      if (!connection || !connection.client) {
        return yield* Effect.fail(
          new MCPToolDiscoveryError({
            serverName,
            reason: `MCP server ${serverName} is not connected`,
            suggestion: `Call connectServer() before getting tools`,
          }),
        );
      }

      // Get tools from MCP client with retry logic
      const getToolsEffect = retryWithBackoff(
        Effect.promise(() => connection.client.tools()),
        {
          maxRetries: 2,
          initialDelayMs: 500,
          maxDelayMs: 5000,
        },
      );

      const toolsRegistry = yield* getToolsEffect.pipe(
        Effect.mapError((error: unknown) => {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return new MCPToolDiscoveryError({
            serverName,
            reason: `Failed to get tools from MCP server: ${errorMessage}`,
            cause: error,
            suggestion: `Check that the MCP server is running and responding correctly`,
          });
        }),
      );

      // Log the raw registry before normalization
      yield* manager.logger.debug(
        `[getServerTools] Raw tools registry from ${serverName}: ${JSON.stringify(toolsRegistry, null, 2).substring(0, 500)}`,
      );

      // Normalize tool registry to array of MCPTool
      const tools = normalizeMCPToolRegistry(toolsRegistry);

      yield* manager.logger.debug(
        `[getServerTools] Normalized ${tools.length} tools from registry for ${serverName}`,
      );

      if (tools.length === 0) {
        yield* manager.logger.warn(`No tools discovered from MCP server ${serverName} - the server may not have any tools available`);
        yield* manager.logger.debug(`[getServerTools] Tools registry was empty or normalized to empty array for ${serverName}`);
      } else {
        yield* manager.logger.debug(
          `Discovered ${tools.length} tool(s) from MCP server ${serverName}: ${tools.map(t => t.name).slice(0, 5).join(", ")}${tools.length > 5 ? "..." : ""}`,
        );
      }

      return tools;
    });
  }

  discoverTools(
    config: MCPServerConfig,
  ): Effect.Effect<
    readonly MCPTool[],
    MCPConnectionError | MCPToolDiscoveryError | MCPDisconnectionError,
    LoggerService | AgentConfigService | TerminalService
  > {
    // Capture this to avoid issues with Effect.gen not preserving context
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const manager = this;
    return Effect.gen(function* () {
      // Connect to server
      yield* manager.logger.debug(`[discoverTools] Connecting to ${config.name}...`);
      yield* manager.connectServer(config);
      yield* manager.logger.debug(`[discoverTools] Connected to ${config.name}`);

      // Get tools
      yield* manager.logger.debug(`[discoverTools] Getting tools from ${config.name}...`);
      const tools = yield* manager.getServerTools(config.name);
      yield* manager.logger.debug(`[discoverTools] Got ${tools.length} tools from ${config.name}`);

      // Disconnect (cleanup)
      yield* manager.disconnectServer(config.name).pipe(
        Effect.catchAll((error: unknown) =>
          Effect.gen(function* () {
            // Log but don't fail - we already have the tools
            const errorMessage =
              error instanceof MCPDisconnectionError
                ? error.reason
                : error instanceof Error
                  ? error.message
                  : String(error);
            yield* manager.logger.warn(
              `Error disconnecting after tool discovery for ${config.name}: ${errorMessage}`,
            );
          }),
        ),
      );

      return tools;
    });
  }

  resolveTemplateVariables(
    config: MCPServerConfig,
  ): Effect.Effect<readonly string[], Error, AgentConfigService | TerminalService> {
    return Effect.gen(function* () {
      const configService = yield* AgentConfigServiceTag;
      const terminal = yield* TerminalServiceTag;

      const resolvedArgs: string[] = [];
      const templatePattern = /\$\{input:(\w+)\}/g;

      for (const arg of config.args || []) {
        const matches = [...arg.matchAll(templatePattern)];

        if (matches.length === 0) {
          // No templates, use as-is
          resolvedArgs.push(arg);
          continue;
        }

        // Resolve each template variable
        let resolvedArg = arg;
        for (const match of matches) {
          const varName = match[1]; // e.g., "pg_url"
          const configKey = `mcpServers.${config.name}.inputs.${varName}`;

          // Check if already stored
          const stored = yield* configService.getOrElse(configKey, undefined);

          if (stored) {
            resolvedArg = resolvedArg.replace(match[0], stored);
          } else {
            // Prompt user
            const value = yield* terminal.ask(
              `Enter value for ${varName} (used by ${config.name} MCP server):`,
              {
                validate: (input) => {
                  if (!input.trim()) {
                    return `${varName} cannot be empty`;
                  }
                  return true;
                },
              },
            );

            // Store in config
            yield* configService.set(configKey, value);
            resolvedArg = resolvedArg.replace(match[0], value);
          }
        }

        resolvedArgs.push(resolvedArg);
      }

      return resolvedArgs;
    });
  }

  listServers(): Effect.Effect<readonly MCPServerConfig[], never, AgentConfigService> {
    return Effect.gen(function* () {
      const configService = yield* AgentConfigServiceTag;
      const mcpServers = yield* configService.getOrElse<Record<string, MCPServerConfig>>(
        "mcpServers",
        {},
      );
      // Add server name to each config
      return Object.entries(mcpServers).map(([name, config]) => ({
        ...config,
        name,
      }));
    });
  }

  isConnected(serverName: string): Effect.Effect<boolean, never> {
    return Effect.sync(() => this.connections.has(serverName));
  }

  disconnectAllServers(): Effect.Effect<void, MCPDisconnectionError, LoggerService> {
    // Capture this to avoid issues with Effect.gen not preserving context
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const manager = this;
    return Effect.gen(function* () {
      const serverNames = Array.from(manager.connections.keys());
      yield* manager.logger.debug(`Disconnecting ${serverNames.length} MCP server(s)...`);

      // Disconnect all servers in parallel
      const disconnectEffects = serverNames.map((serverName) =>
        manager.disconnectServer(serverName).pipe(
          Effect.catchAll((error: unknown) =>
            Effect.gen(function* () {
              const errorMessage =
                error instanceof MCPDisconnectionError
                  ? error.reason
                  : error instanceof Error
                    ? error.message
                    : String(error);
              yield* manager.logger.warn(
                `Failed to disconnect MCP server ${serverName}: ${errorMessage}`,
              );
              // Continue with other servers even if one fails
            }),
          ),
        ),
      );

      yield* Effect.all(disconnectEffects, { concurrency: "unbounded" });
      yield* manager.logger.debug("All MCP servers disconnected");
    });
  }
}

/**
 * Create MCP Server Manager layer
 */
export function createMCPServerManagerLayer(): Layer.Layer<MCPServerManager, never, LoggerService> {
  return Layer.effect(
    MCPServerManagerTag,
    Effect.gen(function* () {
      const logger = yield* LoggerServiceTag;
      return new MCPServerManagerImpl(logger);
    }),
  );
}
