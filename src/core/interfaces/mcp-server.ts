import { Context, Effect } from "effect";
import type { AgentConfigService } from "./agent-config";
import type { LoggerService } from "./logger";
import type { TerminalService } from "./terminal";
import type { MCPClient, MCPTool } from "../types/mcp";
import type {
  MCPConnectionError,
  MCPDisconnectionError,
  MCPToolDiscoveryError,
} from "../types/errors";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * MCP Server configuration
 */
export interface MCPServerConfig {
  readonly name: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
  readonly enabled?: boolean;
  /**
   * Resolved input values (after template variable resolution)
   */
  readonly inputs?: Record<string, string>;
}

/**
 * MCP Server connection state
 */
export interface MCPServerConnection {
  readonly serverName: string;
  readonly process: NodeJS.Process | null;
  readonly client: MCPClient;
  readonly transport: StdioClientTransport;
}

/**
 * MCP Server Manager interface
 *
 * Manages connections to MCP servers, handles template variable resolution,
 * and provides access to MCP tools.
 */
export interface MCPServerManager {
  /**
   * Connect to an MCP server using stdio transport
   */
  readonly connectServer: (
    config: MCPServerConfig,
  ) => Effect.Effect<
    MCPClient,
    MCPConnectionError,
    LoggerService | AgentConfigService | TerminalService
  >;

  /**
   * Disconnect from an MCP server
   */
  readonly disconnectServer: (
    serverName: string,
  ) => Effect.Effect<void, MCPDisconnectionError, LoggerService>;

  /**
   * Get tools from a connected MCP server
   */
  readonly getServerTools: (
    serverName: string,
  ) => Effect.Effect<readonly MCPTool[], MCPToolDiscoveryError, LoggerService>;

  /**
   * Discover tools from an MCP server (connects, discovers, then disconnects)
   * Useful for tool registration without keeping connection open
   */
  readonly discoverTools: (
    config: MCPServerConfig,
  ) => Effect.Effect<
    readonly MCPTool[],
    MCPConnectionError | MCPToolDiscoveryError | MCPDisconnectionError,
    LoggerService | AgentConfigService | TerminalService
  >;

  /**
   * Resolve template variables in server config
   * Prompts user for ${input:variable} values and stores them in config
   */
  readonly resolveTemplateVariables: (
    config: MCPServerConfig,
  ) => Effect.Effect<readonly string[], Error, AgentConfigService | TerminalService>;

  /**
   * List all configured MCP servers
   */
  readonly listServers: () => Effect.Effect<readonly MCPServerConfig[], never, AgentConfigService>;

  /**
   * Check if a server is connected
   */
  readonly isConnected: (serverName: string) => Effect.Effect<boolean, never>;

  /**
   * Disconnect all connected MCP servers
   * Useful for cleanup on exit
   */
  readonly disconnectAllServers: () => Effect.Effect<void, MCPDisconnectionError, LoggerService>;
}

export const MCPServerManagerTag = Context.GenericTag<MCPServerManager>("MCPServerManager");
