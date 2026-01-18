import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Context, Effect } from "effect";
import type {
  MCPConnectionError,
  MCPDisconnectionError,
  MCPToolDiscoveryError,
} from "@/core/types/errors";
import type { MCPClient, MCPTool } from "@/core/types/mcp";
import type { AgentConfigService } from "./agent-config";
import type { LoggerService } from "./logger";
import type { TerminalService } from "./terminal";

/**
 * Transport types supported by MCP servers
 */
export type MCPTransportType = "stdio" | "http";

/**
 * Base MCP Server configuration shared by all transport types
 */
export interface MCPServerConfigBase {
  readonly name: string;
  readonly enabled?: boolean;
  /**
   * Resolved input values (after template variable resolution)
   */
  readonly inputs?: Record<string, string>;
}

/**
 * MCP Server configuration for stdio transport (default)
 */
export interface MCPServerConfigStdio extends MCPServerConfigBase {
  readonly transport?: "stdio";
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
}

/**
 * MCP Server configuration for HTTP (Streamable HTTP) transport
 */
export interface MCPServerConfigHttp extends MCPServerConfigBase {
  readonly transport: "http";
  readonly url: string;
  /**
   * Optional headers to include in HTTP requests (e.g., Authorization)
   */
  readonly headers?: Record<string, string>;
  /**
   * Session ID for stateful connections (optional)
   */
  readonly sessionId?: string;
}

/**
 * MCP Server configuration (union of all transport types)
 */
export type MCPServerConfig = MCPServerConfigStdio | MCPServerConfigHttp;

/**
 * Type guard for stdio transport config
 */
export function isStdioConfig(config: MCPServerConfig): config is MCPServerConfigStdio {
  return config.transport === undefined || config.transport === "stdio";
}

/**
 * Type guard for HTTP transport config
 */
export function isHttpConfig(config: MCPServerConfig): config is MCPServerConfigHttp {
  return config.transport === "http";
}

/**
 * MCP Server transport union type
 */
export type MCPTransport = StdioClientTransport | StreamableHTTPClientTransport;

/**
 * MCP Server connection state
 */
export interface MCPServerConnection {
  readonly serverName: string;
  readonly process: NodeJS.Process | null;
  readonly client: MCPClient;
  readonly transport: MCPTransport;
  readonly transportType: MCPTransportType;
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
   * Only applicable to stdio transport configs (which have args)
   */
  readonly resolveTemplateVariables: (
    config: MCPServerConfigStdio,
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
