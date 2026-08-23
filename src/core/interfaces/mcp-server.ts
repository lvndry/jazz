import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Context, Effect } from "effect";
import type {
  MCPConnectionError,
  MCPDisconnectionError,
  MCPPromptError,
  MCPResourceError,
  MCPToolDiscoveryError,
  MCPToolExecutionError,
} from "@/core/types/errors";
import type {
  MCPElicitationRequest,
  MCPElicitationResponse,
  MCPProgress,
  MCPPrompt,
  MCPPromptResult,
  MCPResource,
  MCPResourceContent,
  MCPResourceTemplate,
  MCPServerCapabilities,
  MCPTool,
  MCPToolResult,
} from "@/core/types/mcp";
import type { AgentConfigService } from "./agent-config";
import type { LoggerService } from "./logger";

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
   * Whether the user vouches for this server.
   *
   * Tool annotations are self-declared, so they only relax the approval gate
   * for servers marked here. An untrusted server's tools always prompt no
   * matter what it claims about them.
   */
  readonly trusted?: boolean;
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
   * Optional headers to include in HTTP requests (e.g., Authorization).
   * Static headers bypass the OAuth flow entirely.
   */
  readonly headers?: Record<string, string>;
  /**
   * Session ID for stateful connections (optional)
   */
  readonly conversationId?: string;
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
 * Asks the user a server's elicitation question.
 *
 * Registered only by surfaces that can actually reach a person; where none is
 * registered the manager declines, which is what an unattended run needs.
 */
export type ElicitationHandler = (
  request: MCPElicitationRequest,
) => Promise<MCPElicitationResponse>;

/**
 * Receives progress reports from a long-running server operation.
 *
 * A server doing thirty seconds of work is otherwise indistinguishable from a
 * hung one, so these are surfaced rather than dropped.
 */
export type ProgressReporter = (progress: MCPProgress) => void;

/** Called when a server reports its tool list changed. */
export type ToolsChangedHandler = (serverName: string, tools: readonly MCPTool[]) => void;

/**
 * MCP Server Manager interface
 *
 * Owns one `Client` per configured server and exposes the subset of the
 * protocol Jazz uses: tools, prompts, and list-changed notifications.
 */
export interface MCPServerManager {
  /**
   * Connect to an MCP server. Reconnecting an already-connected server is a
   * no-op.
   */
  readonly connectServer: (
    config: MCPServerConfig,
  ) => Effect.Effect<void, MCPConnectionError, LoggerService>;

  /**
   * Disconnect from an MCP server
   */
  readonly disconnectServer: (
    serverName: string,
  ) => Effect.Effect<void, MCPDisconnectionError, LoggerService>;

  /**
   * List tools advertised by a connected server.
   */
  readonly getServerTools: (
    serverName: string,
  ) => Effect.Effect<readonly MCPTool[], MCPToolDiscoveryError, LoggerService>;

  /**
   * Invoke a tool on a connected server.
   */
  readonly callTool: (
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    onProgress?: ProgressReporter,
  ) => Effect.Effect<MCPToolResult, MCPToolExecutionError, LoggerService>;

  /**
   * List prompts advertised by a connected server. Servers that do not
   * advertise the `prompts` capability return an empty list rather than error.
   */
  readonly getServerPrompts: (
    serverName: string,
  ) => Effect.Effect<readonly MCPPrompt[], MCPPromptError, LoggerService>;

  /**
   * Resolve one prompt with arguments applied.
   */
  readonly getPrompt: (
    serverName: string,
    promptName: string,
    args: Record<string, string>,
  ) => Effect.Effect<MCPPromptResult, MCPPromptError, LoggerService>;

  /**
   * Which protocol era a connection negotiated — "modern" for 2026-07-28,
   * "legacy" for the 2025 handshake. Undefined when not connected.
   */
  readonly getProtocolEra: (serverName: string) => Effect.Effect<string | undefined, never>;

  /**
   * Capabilities the server declared at initialize, or undefined when not
   * connected.
   */
  readonly getCapabilities: (
    serverName: string,
  ) => Effect.Effect<MCPServerCapabilities | undefined, never>;

  /**
   * Subscribe to `notifications/tools/list_changed`. Returns an unsubscribe
   * function. Handlers fire with the re-listed tools already resolved.
   */
  readonly onToolsChanged: (handler: ToolsChangedHandler) => Effect.Effect<() => void, never>;

  /**
   * List resources a connected server exposes. Servers that do not advertise
   * the `resources` capability return an empty list rather than error.
   */
  readonly getServerResources: (
    serverName: string,
  ) => Effect.Effect<readonly MCPResource[], MCPResourceError, LoggerService>;

  /**
   * Read one resource by URI.
   */
  readonly readResource: (
    serverName: string,
    uri: string,
  ) => Effect.Effect<readonly MCPResourceContent[], MCPResourceError, LoggerService>;

  /**
   * List a server's parameterized resource URIs. Servers that advertise
   * resources without implementing templates return an empty list.
   */
  readonly getResourceTemplates: (
    serverName: string,
  ) => Effect.Effect<readonly MCPResourceTemplate[], MCPResourceError, LoggerService>;

  /**
   * Ask a server to complete a partially typed prompt or resource argument.
   * Returns an empty list when the server does not implement completion.
   */
  readonly completeArgument: (
    serverName: string,
    reference: { readonly type: "prompt" | "resource"; readonly name: string },
    argumentName: string,
    partialValue: string,
  ) => Effect.Effect<readonly string[], never, LoggerService>;

  /**
   * Register the handler that answers servers' elicitation requests. Returns an
   * unregister function.
   */
  readonly onElicitation: (handler: ElicitationHandler) => Effect.Effect<() => void, never>;

  /**
   * Discover tools from an MCP server (connects, discovers, then disconnects)
   * Useful for tool registration without keeping connection open
   */
  readonly discoverTools: (
    config: MCPServerConfig,
  ) => Effect.Effect<
    readonly MCPTool[],
    MCPConnectionError | MCPToolDiscoveryError | MCPDisconnectionError,
    LoggerService
  >;

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
