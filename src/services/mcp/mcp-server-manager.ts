import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Transport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Effect, Layer } from "effect";
import type { AgentConfigService } from "@/core/interfaces/agent-config";
import { AgentConfigServiceTag } from "@/core/interfaces/agent-config";
import type { LoggerService } from "@/core/interfaces/logger";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import type {
  ElicitationHandler,
  MCPServerConfig,
  MCPServerManager,
  MCPTransport,
  MCPTransportType,
  ProgressReporter,
  ToolsChangedHandler,
} from "@/core/interfaces/mcp-server";
import { isHttpConfig, isStdioConfig, MCPServerManagerTag } from "@/core/interfaces/mcp-server";
import {
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
  MCPJSONSchema,
  MCPPrompt,
  MCPPromptResult,
  MCPResource,
  MCPResourceContent,
  MCPResourceTemplate,
  MCPServerCapabilities,
  MCPTool,
  MCPToolResult,
} from "@/core/types/mcp";
import { createSanitizedEnv } from "@/core/utils/env";
import { retryWithBackoff } from "@/core/utils/mcp";
import { toElicitationFields } from "./elicitation-schema";
import { createStoredTokenProvider, InteractiveAuthRequiredError } from "./oauth";
import packageJson from "../../../package.json";

/**
 * Ceiling on a single connect attempt.
 *
 * A stdio server that spawns but never answers `initialize` would otherwise
 * hang the first tool call forever — the child process is alive, so nothing
 * below this layer ever times out.
 */
const CONNECT_TIMEOUT_MS = 30_000;

/** Ceiling on one `tools/call`. Servers reach networks; they can stall. */
const CALL_TIMEOUT_MS = 120_000;

/** Guard against a server paginating `tools/list` without end. */
const MAX_LIST_PAGES = 50;

/** Narrow an SDK tool definition to the fields Jazz reads. */
function toMCPTool(tool: {
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?:
    | {
        readOnlyHint?: boolean | undefined;
        destructiveHint?: boolean | undefined;
        idempotentHint?: boolean | undefined;
        openWorldHint?: boolean | undefined;
      }
    | undefined;
}): MCPTool {
  return {
    name: tool.name,
    ...(tool.title !== undefined ? { title: tool.title } : {}),
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema as MCPJSONSchema } : {}),
    ...(tool.outputSchema !== undefined
      ? { outputSchema: tool.outputSchema as MCPJSONSchema }
      : {}),
    ...(tool.annotations !== undefined
      ? {
          annotations: {
            readOnlyHint: tool.annotations.readOnlyHint,
            destructiveHint: tool.annotations.destructiveHint,
            idempotentHint: tool.annotations.idempotentHint,
            openWorldHint: tool.annotations.openWorldHint,
          },
        }
      : {}),
  };
}

interface Connection {
  readonly serverName: string;
  readonly client: Client;
  readonly transport: MCPTransport;
  readonly transportType: MCPTransportType;
  readonly capabilities: MCPServerCapabilities | undefined;
  /** Which protocol era the connection negotiated: "modern" is 2026-07-28. */
  readonly protocolEra: string | undefined;
}

/**
 * MCP Server Manager implementation
 *
 * Speaks to servers through the reference `Client` from
 * `@modelcontextprotocol/sdk` rather than a wrapper, which is what makes tool
 * annotations, prompts, and list-changed notifications reachable.
 */
class MCPServerManagerImpl implements MCPServerManager {
  private connections: Map<string, Connection>;
  private toolsChangedHandlers: Set<ToolsChangedHandler>;
  private logger: LoggerService;
  /**
   * Set by whichever surface can actually put a question to a person. Left
   * unset on bridges and scheduled runs, where the correct answer to an
   * elicitation is to decline rather than to block forever.
   */
  private elicitationHandler: ElicitationHandler | undefined;

  constructor(logger: LoggerService) {
    this.connections = new Map();
    this.toolsChangedHandlers = new Set();
    this.logger = logger;
    this.elicitationHandler = undefined;
  }

  private buildTransport(config: MCPServerConfig): {
    transport: MCPTransport;
    transportType: MCPTransportType;
  } {
    if (isHttpConfig(config)) {
      const options: ConstructorParameters<typeof StreamableHTTPClientTransport>[1] = {};

      if (config.headers) {
        options.requestInit = { headers: config.headers };
      } else {
        // Static headers are the user saying "authenticate this way"; only fall
        // back to OAuth when they have not.
        options.authProvider = createStoredTokenProvider(config.name, config.url);
      }

      if (config.conversationId) {
        options.sessionId = config.conversationId;
      }

      return {
        transport: new StreamableHTTPClientTransport(new URL(config.url), options),
        transportType: "http",
      };
    }

    const sanitizedEnv = createSanitizedEnv(config.env || {});

    return {
      transport: new StdioClientTransport({
        command: config.command,
        args: [...(config.args ?? [])],
        env: sanitizedEnv as Record<string, string>,
      }),
      transportType: "stdio",
    };
  }

  /**
   * Fan a server's new tool list out to subscribers.
   *
   * `items` is null only when auto-refresh is disabled, which Jazz does not do;
   * it is still guarded so a change never turns into an empty tool list.
   */
  private handleToolsChanged(
    serverName: string,
    items:
      | readonly {
          name: string;
          title?: string | undefined;
          description?: string | undefined;
          inputSchema?: unknown;
          outputSchema?: unknown;
          annotations?:
            | {
                readOnlyHint?: boolean | undefined;
                destructiveHint?: boolean | undefined;
                idempotentHint?: boolean | undefined;
                openWorldHint?: boolean | undefined;
              }
            | undefined;
        }[]
      | null,
  ): void {
    if (items === null || this.toolsChangedHandlers.size === 0) return;

    const tools = items.map(toMCPTool);
    for (const handler of this.toolsChangedHandlers) {
      try {
        handler(serverName, tools);
      } catch {
        // One bad subscriber must not stop the others.
      }
    }
  }

  connectServer(config: MCPServerConfig): Effect.Effect<void, MCPConnectionError, LoggerService> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const manager = this;
    return Effect.gen(function* () {
      if (manager.connections.has(config.name)) {
        yield* manager.logger.debug(`MCP server ${config.name} already connected`);
        return;
      }

      yield* manager.logger.debug(`Connecting to MCP server: ${config.name}`);

      const { transport, transportType } = manager.buildTransport(config);

      const client = new Client(
        { name: "jazz", version: packageJson.version },
        {
          // Roots is deliberately not declared: 2026-07-28 deprecates it
          // (SEP-2577) and removes notifications/roots/list_changed, with the
          // migration being to pass directories as tool parameters or server
          // config instead.
          //
          // `elicitation` is advertised unconditionally even though a given
          // surface may have no way to ask a person: the capability says Jazz
          // speaks the request, and declining is a valid answer to it. On a
          // 2026-era connection the SDK fulfils the same handler through the
          // multi-round-trip `input_required` flow, so one handler serves both.
          capabilities: { elicitation: {} },
          // Probe `server/discover` for the 2026-07-28 era and fall back to the
          // 2025 handshake against older servers, at the cost of one round trip.
          versionNegotiation: { mode: "auto" },
          // Era-transparent list-change handling: unsolicited notifications on
          // 2025 connections, an auto-opened `subscriptions/listen` stream on
          // 2026 ones. The SDK re-lists and hands back the new items, which is
          // why nothing here re-fetches by hand.
          listChanged: {
            tools: {
              onChanged: (error, items) => {
                if (error) {
                  void Effect.runPromise(
                    manager.logger
                      .warn(
                        `Failed to refresh tools for ${config.name} after a list change: ${error.message}`,
                      )
                      .pipe(Effect.catchAllCause(() => Effect.void)),
                  );
                  return;
                }
                manager.handleToolsChanged(config.name, items);
              },
            },
          },
        },
      );

      // v2 registers handlers by method name rather than by schema.
      client.setRequestHandler("elicitation/create", (request) =>
        manager.handleElicitation(config.name, request.params),
      );

      const connectEffect = Effect.tryPromise({
        try: () => client.connect(transport as Transport),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }).pipe(
        Effect.timeoutFail({
          duration: `${CONNECT_TIMEOUT_MS} millis`,
          onTimeout: () =>
            new Error(`Server did not complete the MCP handshake within ${CONNECT_TIMEOUT_MS}ms`),
        }),
      );

      yield* retryWithBackoff(connectEffect, {
        maxRetries: 3,
        initialDelayMs: 1000,
        maxDelayMs: 10_000,
        shouldRetry: (error: unknown) => {
          // An unauthorized server will answer the same way every time, and a
          // missing binary will never appear mid-retry. Only genuinely
          // transient transport faults are worth the backoff.
          if (error instanceof InteractiveAuthRequiredError) return false;
          const errorMessage = error instanceof Error ? error.message : String(error);
          if (/\b(401|403|ENOENT|EACCES)\b/.test(errorMessage)) return false;
          return (
            errorMessage.includes("ECONNREFUSED") ||
            errorMessage.includes("ECONNRESET") ||
            errorMessage.includes("ETIMEDOUT") ||
            errorMessage.includes("socket hang up")
          );
        },
      }).pipe(
        Effect.mapError((error: unknown) => {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const suggestion =
            error instanceof InteractiveAuthRequiredError
              ? `Run: jazz mcp auth ${config.name}`
              : isStdioConfig(config)
                ? `Check that the command "${config.command}" is available and the server is configured correctly`
                : `Check that the URL "${config.url}" is accessible and the server is running`;
          return new MCPConnectionError({
            serverName: config.name,
            reason: `Failed to connect to MCP server: ${errorMessage}`,
            cause: error,
            suggestion,
          });
        }),
      );

      const rawCapabilities = client.getServerCapabilities();
      const capabilities: MCPServerCapabilities | undefined = rawCapabilities
        ? {
            ...(rawCapabilities.tools !== undefined ? { tools: rawCapabilities.tools } : {}),
            ...(rawCapabilities.prompts !== undefined ? { prompts: rawCapabilities.prompts } : {}),
            ...(rawCapabilities.resources !== undefined
              ? { resources: rawCapabilities.resources }
              : {}),
          }
        : undefined;

      const protocolEra = client.getProtocolEra();

      manager.connections.set(config.name, {
        serverName: config.name,
        client,
        transport,
        transportType,
        capabilities,
        protocolEra,
      });

      yield* manager.logger.info(
        `Connected to MCP server: ${config.name} (${transportType} transport, ${protocolEra ?? "unknown"} protocol era)`,
      );
    }).pipe(
      Effect.mapError((error: unknown) => {
        if (error instanceof MCPConnectionError) return error;
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

  disconnectServer(serverName: string): Effect.Effect<void, MCPDisconnectionError, LoggerService> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const manager = this;
    return Effect.gen(function* () {
      const connection = manager.connections.get(serverName);
      if (!connection) {
        yield* manager.logger.debug(`MCP server ${serverName} not connected`);
        return;
      }

      // Dropped from the map first: a close that hangs must not leave a dead
      // connection looking live to the next caller.
      manager.connections.delete(serverName);

      yield* Effect.tryPromise({
        try: () => connection.client.close(),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }).pipe(
        Effect.catchAll((error: unknown) =>
          manager.logger.warn(
            `Error closing MCP client for ${serverName}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        ),
      );

      yield* manager.logger.info(`Disconnected from MCP server: ${serverName}`);
    });
  }

  getServerTools(
    serverName: string,
  ): Effect.Effect<readonly MCPTool[], MCPToolDiscoveryError, LoggerService> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const manager = this;
    return Effect.gen(function* () {
      const connection = manager.connections.get(serverName);
      if (!connection) {
        return yield* Effect.fail(
          new MCPToolDiscoveryError({
            serverName,
            reason: `MCP server ${serverName} is not connected`,
            suggestion: `Call connectServer() before getting tools`,
          }),
        );
      }

      const tools = yield* retryWithBackoff(
        Effect.tryPromise({
          try: async () => {
            const collected: MCPTool[] = [];
            let cursor: string | undefined;

            for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
              const result = await connection.client.listTools(
                cursor === undefined ? {} : { cursor },
              );

              for (const tool of result.tools) {
                collected.push(toMCPTool(tool));
              }

              cursor = result.nextCursor;
              if (cursor === undefined) break;
            }

            return collected;
          },
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }),
        { maxRetries: 2, initialDelayMs: 500, maxDelayMs: 5000 },
      ).pipe(
        Effect.mapError(
          (error: unknown) =>
            new MCPToolDiscoveryError({
              serverName,
              reason: `Failed to get tools from MCP server: ${error instanceof Error ? error.message : String(error)}`,
              cause: error,
              suggestion: `Check that the MCP server is running and responding correctly`,
            }),
        ),
      );

      if (tools.length === 0) {
        yield* manager.logger.warn(
          `No tools discovered from MCP server ${serverName} - the server may not have any tools available`,
        );
      } else {
        yield* manager.logger.debug(
          `Discovered ${tools.length} tool(s) from MCP server ${serverName}: ${tools
            .map((tool) => tool.name)
            .slice(0, 5)
            .join(", ")}${tools.length > 5 ? "..." : ""}`,
        );
      }

      return tools;
    });
  }

  callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    onProgress?: ProgressReporter,
  ): Effect.Effect<MCPToolResult, MCPToolExecutionError, LoggerService> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const manager = this;
    return Effect.gen(function* () {
      const connection = manager.connections.get(serverName);
      if (!connection) {
        return yield* Effect.fail(
          new MCPToolExecutionError({
            serverName,
            toolName,
            reason: `MCP server ${serverName} is not connected`,
            suggestion: `The connection may have dropped; retry to reconnect`,
          }),
        );
      }

      const result = yield* Effect.tryPromise({
        try: () =>
          connection.client.callTool(
            { name: toolName, arguments: args },
            onProgress
              ? {
                  onprogress: (progress) => {
                    onProgress({
                      progress: progress.progress,
                      ...(progress.total !== undefined ? { total: progress.total } : {}),
                      ...(progress.message !== undefined ? { message: progress.message } : {}),
                    });
                  },
                  // A server that keeps reporting is working, not hung — let it
                  // keep going rather than timing out mid-report.
                  resetTimeoutOnProgress: true,
                  maxTotalTimeout: CALL_TIMEOUT_MS,
                }
              : undefined,
          ),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }).pipe(
        Effect.timeoutFail({
          duration: `${CALL_TIMEOUT_MS} millis`,
          onTimeout: () => new Error(`Tool call exceeded ${CALL_TIMEOUT_MS}ms`),
        }),
        Effect.mapError(
          (error: unknown) =>
            new MCPToolExecutionError({
              serverName,
              toolName,
              reason: `MCP tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
              cause: error,
              suggestion: `Check that the tool arguments are correct and the MCP server is functioning properly`,
            }),
        ),
      );

      return {
        ...(result.content !== undefined ? { content: result.content } : {}),
        ...(result.structuredContent !== undefined
          ? { structuredContent: result.structuredContent }
          : {}),
        ...(result.isError !== undefined ? { isError: result.isError === true } : {}),
      };
    });
  }

  getServerPrompts(
    serverName: string,
  ): Effect.Effect<readonly MCPPrompt[], MCPPromptError, LoggerService> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const manager = this;
    return Effect.gen(function* () {
      const connection = manager.connections.get(serverName);
      if (!connection) {
        return yield* Effect.fail(
          new MCPPromptError({
            serverName,
            reason: `MCP server ${serverName} is not connected`,
            suggestion: `Call connectServer() before listing prompts`,
          }),
        );
      }

      // Asking a server that never advertised prompts earns a "method not
      // found" error; absence of the capability is a normal answer, not a
      // failure.
      if (connection.capabilities?.prompts === undefined) {
        yield* manager.logger.debug(`MCP server ${serverName} does not advertise prompts`);
        return [];
      }

      return yield* Effect.tryPromise({
        try: async () => {
          const collected: MCPPrompt[] = [];
          let cursor: string | undefined;

          for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
            const result = await connection.client.listPrompts(
              cursor === undefined ? {} : { cursor },
            );

            for (const prompt of result.prompts) {
              collected.push({
                name: prompt.name,
                ...(prompt.title !== undefined ? { title: prompt.title } : {}),
                ...(prompt.description !== undefined ? { description: prompt.description } : {}),
                ...(prompt.arguments !== undefined
                  ? {
                      arguments: prompt.arguments.map((argument) => ({
                        name: argument.name,
                        ...(argument.description !== undefined
                          ? { description: argument.description }
                          : {}),
                        ...(argument.required !== undefined ? { required: argument.required } : {}),
                      })),
                    }
                  : {}),
              });
            }

            cursor = result.nextCursor;
            if (cursor === undefined) break;
          }

          return collected;
        },
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }).pipe(
        Effect.mapError(
          (error: unknown) =>
            new MCPPromptError({
              serverName,
              reason: `Failed to list prompts: ${error instanceof Error ? error.message : String(error)}`,
              cause: error,
              suggestion: `Check that the MCP server is running and responding correctly`,
            }),
        ),
      );
    });
  }

  getPrompt(
    serverName: string,
    promptName: string,
    args: Record<string, string>,
  ): Effect.Effect<MCPPromptResult, MCPPromptError, LoggerService> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const manager = this;
    return Effect.gen(function* () {
      const connection = manager.connections.get(serverName);
      if (!connection) {
        return yield* Effect.fail(
          new MCPPromptError({
            serverName,
            reason: `MCP server ${serverName} is not connected`,
            suggestion: `Call connectServer() before resolving a prompt`,
          }),
        );
      }

      const result = yield* Effect.tryPromise({
        try: () => connection.client.getPrompt({ name: promptName, arguments: args }),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }).pipe(
        Effect.mapError(
          (error: unknown) =>
            new MCPPromptError({
              serverName,
              reason: `Failed to resolve prompt "${promptName}": ${error instanceof Error ? error.message : String(error)}`,
              cause: error,
              suggestion: `Check the prompt name and that all required arguments were supplied`,
            }),
        ),
      );

      return {
        ...(result.description !== undefined ? { description: result.description } : {}),
        messages: result.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      };
    });
  }

  /**
   * Answer a server's `elicitation/create`.
   *
   * Declines rather than blocking whenever there is nobody to ask — an
   * unattended bridge or scheduled run has no way to surface a dialog, and a
   * hung request there would stall the whole job.
   */
  private async handleElicitation(
    serverName: string,
    params: {
      mode?: string | undefined;
      message?: string | undefined;
      requestedSchema?: unknown;
    },
  ): Promise<{
    action: "accept" | "decline" | "cancel";
    content?: Record<string, string | number | boolean | string[]>;
  }> {
    const handler = this.elicitationHandler;

    if (!handler) {
      await Effect.runPromise(
        this.logger.debug(
          `Declined elicitation from ${serverName}: this surface cannot prompt the user`,
        ),
      );
      return { action: "decline" };
    }

    // URL mode hands the user off to a browser page the server controls. Jazz
    // has no way to confirm what happens there, so it is declined rather than
    // silently opened.
    if (params.mode === "url") {
      await Effect.runPromise(
        this.logger.warn(`Declined URL-mode elicitation from ${serverName}: not supported`),
      );
      return { action: "decline" };
    }

    const request: MCPElicitationRequest = {
      serverName,
      message: typeof params.message === "string" ? params.message : "",
      fields: toElicitationFields(params.requestedSchema),
    };

    try {
      const response: MCPElicitationResponse = await handler(request);
      if (response.action !== "accept") {
        return { action: response.action };
      }

      // v2 types elicitation content precisely, and a readonly array is not
      // assignable to the mutable one the wire type declares.
      const content: Record<string, string | number | boolean | string[]> = {};
      for (const [key, value] of Object.entries(response.content)) {
        // `Array.isArray` does not narrow a readonly array out of the union,
        // so the scalar cases are what get tested.
        content[key] =
          typeof value === "string" || typeof value === "number" || typeof value === "boolean"
            ? value
            : [...value];
      }
      return { action: "accept", content };
    } catch (error) {
      await Effect.runPromise(
        this.logger.warn(
          `Elicitation handler failed for ${serverName}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      return { action: "cancel" };
    }
  }

  onElicitation(handler: ElicitationHandler): Effect.Effect<() => void, never> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const manager = this;
    return Effect.sync(() => {
      manager.elicitationHandler = handler;
      return () => {
        if (manager.elicitationHandler === handler) {
          manager.elicitationHandler = undefined;
        }
      };
    });
  }

  getServerResources(
    serverName: string,
  ): Effect.Effect<readonly MCPResource[], MCPResourceError, LoggerService> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const manager = this;
    return Effect.gen(function* () {
      const connection = manager.connections.get(serverName);
      if (!connection) {
        return yield* Effect.fail(
          new MCPResourceError({
            serverName,
            reason: `MCP server ${serverName} is not connected`,
            suggestion: `Call connectServer() before listing resources`,
          }),
        );
      }

      if (connection.capabilities?.resources === undefined) {
        return [];
      }

      return yield* Effect.tryPromise({
        try: async () => {
          const collected: MCPResource[] = [];
          let cursor: string | undefined;

          for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
            const result = await connection.client.listResources(
              cursor === undefined ? {} : { cursor },
            );

            for (const resource of result.resources) {
              collected.push({
                uri: resource.uri,
                name: resource.name,
                title: resource.title,
                description: resource.description,
                mimeType: resource.mimeType,
              });
            }

            cursor = result.nextCursor;
            if (cursor === undefined) break;
          }

          return collected;
        },
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }).pipe(
        Effect.mapError(
          (error: unknown) =>
            new MCPResourceError({
              serverName,
              reason: `Failed to list resources: ${error instanceof Error ? error.message : String(error)}`,
              cause: error,
              suggestion: `Check that the MCP server is running and responding correctly`,
            }),
        ),
      );
    });
  }

  readResource(
    serverName: string,
    uri: string,
  ): Effect.Effect<readonly MCPResourceContent[], MCPResourceError, LoggerService> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const manager = this;
    return Effect.gen(function* () {
      const connection = manager.connections.get(serverName);
      if (!connection) {
        return yield* Effect.fail(
          new MCPResourceError({
            serverName,
            reason: `MCP server ${serverName} is not connected`,
            suggestion: `Call connectServer() before reading a resource`,
          }),
        );
      }

      const result = yield* Effect.tryPromise({
        try: () => connection.client.readResource({ uri }),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }).pipe(
        Effect.mapError(
          (error: unknown) =>
            new MCPResourceError({
              serverName,
              reason: `Failed to read resource "${uri}": ${error instanceof Error ? error.message : String(error)}`,
              cause: error,
              suggestion: `Check that the URI is one the server advertises`,
            }),
        ),
      );

      return result.contents.map((content) => ({
        uri: content.uri,
        mimeType: content.mimeType,
        ...("text" in content && typeof content.text === "string" ? { text: content.text } : {}),
        ...("blob" in content && typeof content.blob === "string" ? { blob: content.blob } : {}),
      }));
    });
  }

  getResourceTemplates(
    serverName: string,
  ): Effect.Effect<readonly MCPResourceTemplate[], MCPResourceError, LoggerService> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const manager = this;
    return Effect.gen(function* () {
      const connection = manager.connections.get(serverName);
      if (!connection || connection.capabilities?.resources === undefined) {
        return [];
      }

      return yield* Effect.tryPromise({
        try: async () => {
          const result = await connection.client.listResourceTemplates({});
          return result.resourceTemplates.map((template) => ({
            uriTemplate: template.uriTemplate,
            name: template.name,
            title: template.title,
            description: template.description,
            mimeType: template.mimeType,
          }));
        },
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }).pipe(
        // A server may advertise `resources` without implementing templates, so
        // a failure here means "none", not a broken server.
        Effect.catchAll(() => Effect.succeed([] as readonly MCPResourceTemplate[])),
      );
    });
  }

  completeArgument(
    serverName: string,
    reference: { readonly type: "prompt" | "resource"; readonly name: string },
    argumentName: string,
    partialValue: string,
    resolvedArguments: Record<string, string> = {},
  ): Effect.Effect<readonly string[], never, LoggerService> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const manager = this;
    return Effect.gen(function* () {
      const connection = manager.connections.get(serverName);
      if (!connection) return [];

      return yield* Effect.tryPromise({
        try: async () => {
          const result = await connection.client.complete({
            ref:
              reference.type === "prompt"
                ? { type: "ref/prompt", name: reference.name }
                : { type: "ref/resource", uri: reference.name },
            argument: { name: argumentName, value: partialValue },
            // Servers may narrow one argument by the values already chosen for
            // earlier ones; without this such an argument completes to nothing.
            ...(Object.keys(resolvedArguments).length > 0
              ? { context: { arguments: resolvedArguments } }
              : {}),
          });
          return result.completion.values;
        },
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }).pipe(
        // Completion is a convenience: a server that does not implement it
        // should cost the user a picker, not the whole prompt.
        Effect.catchAll(() => Effect.succeed([] as readonly string[])),
      );
    });
  }

  getProtocolEra(serverName: string): Effect.Effect<string | undefined, never> {
    return Effect.sync(() => this.connections.get(serverName)?.protocolEra);
  }

  getCapabilities(serverName: string): Effect.Effect<MCPServerCapabilities | undefined, never> {
    return Effect.sync(() => this.connections.get(serverName)?.capabilities);
  }

  onToolsChanged(handler: ToolsChangedHandler): Effect.Effect<() => void, never> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const manager = this;
    return Effect.sync(() => {
      manager.toolsChangedHandlers.add(handler);
      return () => manager.toolsChangedHandlers.delete(handler);
    });
  }

  discoverTools(
    config: MCPServerConfig,
  ): Effect.Effect<
    readonly MCPTool[],
    MCPConnectionError | MCPToolDiscoveryError | MCPDisconnectionError,
    LoggerService
  > {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const manager = this;
    return Effect.gen(function* () {
      // A server already in use stays connected: discovery is a read, and
      // tearing down a live connection to satisfy it would break the caller.
      const wasConnected = manager.connections.has(config.name);

      yield* manager.connectServer(config);
      const tools = yield* manager.getServerTools(config.name);

      if (!wasConnected) {
        yield* manager
          .disconnectServer(config.name)
          .pipe(
            Effect.catchAll((error) =>
              manager.logger.warn(
                `Error disconnecting after tool discovery for ${config.name}: ${error.reason}`,
              ),
            ),
          );
      }

      return tools;
    });
  }

  listServers(): Effect.Effect<readonly MCPServerConfig[], never, AgentConfigService> {
    return Effect.gen(function* () {
      const configService = yield* AgentConfigServiceTag;
      const mcpServers = yield* configService.getOrElse<Record<string, MCPServerConfig>>(
        "mcpServers",
        {},
      );
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
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const manager = this;
    return Effect.gen(function* () {
      const serverNames = Array.from(manager.connections.keys());
      yield* manager.logger.debug(`Disconnecting ${serverNames.length} MCP server(s)...`);

      yield* Effect.all(
        serverNames.map((serverName) =>
          manager
            .disconnectServer(serverName)
            .pipe(
              Effect.catchAll((error) =>
                manager.logger.warn(
                  `Failed to disconnect MCP server ${serverName}: ${error.reason}`,
                ),
              ),
            ),
        ),
        { concurrency: "unbounded" },
      );

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
