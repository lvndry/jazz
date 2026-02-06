import { Effect } from "effect";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import React from "react";
import { z } from "zod";
import type { AgentConfigService } from "@/core/interfaces/agent-config";
import { AgentConfigServiceTag } from "@/core/interfaces/agent-config";
import type { LoggerService } from "@/core/interfaces/logger";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import type { MCPServerConfig, MCPServerManager } from "@/core/interfaces/mcp-server";
import { MCPServerManagerTag } from "@/core/interfaces/mcp-server";
import type { TerminalService } from "@/core/interfaces/terminal";
import { ink, TerminalServiceTag } from "@/core/interfaces/terminal";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";
import {
  MCPToolExecutionError,
} from "@/core/types/errors";
import type { MCPTool } from "@/core/types/mcp";
import { convertMCPSchemaToZod } from "@/core/utils/mcp-schema-converter";
import { safeStringify, toPascalCase } from "@/core/utils/string";
import { defineTool } from "./base-tool";

/**
 * MCP Tool Dependencies - all services needed for MCP tool operations
 */
export type MCPToolDependencies =
  | AgentConfigService
  | LoggerService
  | MCPServerManager
  | TerminalService;


/**
 * Adapt an MCP tool to a Jazz tool with lazy connection support
 *
 * @param serverConfig - The MCP server configuration for reconnection
 * @param mcpTool - The MCP tool definition
 */
function adaptMCPToolToJazz(
  serverConfig: MCPServerConfig,
  mcpTool: {
    name: string;
    description?: string | undefined;
    inputSchema?: unknown;
  },
): Tool<MCPToolDependencies> {
  // Create prefixed tool name for Jazz (e.g., mcp_mongodb_aggregate)
  const jazzToolName = `mcp_${serverConfig.name.toLowerCase()}_${mcpTool.name}`;
  // Keep original MCP tool name for lookup (e.g., aggregate)
  const mcpToolName = mcpTool.name;

  // Convert MCP schema to Zod
  // LLM function calling requires object schemas, so we must ensure we always return an object schema
  let parameters: z.ZodTypeAny;

  if (mcpTool.inputSchema === undefined || mcpTool.inputSchema === null) {
    // No schema provided - default to empty object
    parameters = z.object({});
  } else {
    parameters = convertMCPSchemaToZod(mcpTool.inputSchema, mcpToolName);

    // Check if the result is z.unknown() by inspecting the internal type
    // z.unknown() has _def.typeName === "ZodUnknown"
    const zodDef = (parameters as { _def?: { typeName?: string } })._def;
    if (zodDef?.typeName === "ZodUnknown") {
      // Invalid or unsupported schema - default to empty object for LLM compatibility
      parameters = z.object({});
    }
  }

  return defineTool<MCPToolDependencies, Record<string, unknown>>({
    name: jazzToolName,
    description: mcpTool.description || `MCP tool: ${mcpToolName}`,
    parameters,
    hidden: false,
    handler: (args: Record<string, unknown>, context: ToolExecutionContext) =>
      executeMCPToolWithLazyConnection(serverConfig, mcpToolName, args, context),
  });
}

/**
 * Execute an MCP tool with lazy connection support
 *
 * This function handles the lazy connection pattern:
 * 1. Check if the server is connected
 * 2. If not, reconnect to the server
 * 3. Execute the tool
 */
function executeMCPToolWithLazyConnection(
  serverConfig: MCPServerConfig,
  toolName: string,
  args: Record<string, unknown>,
  _context: ToolExecutionContext,
): Effect.Effect<ToolExecutionResult, Error, MCPToolDependencies> {
  return Effect.gen(function* () {
    const mcpManager = yield* MCPServerManagerTag;
    const logger = yield* LoggerServiceTag;
    const configService = yield* AgentConfigServiceTag;
    const terminal = yield* TerminalServiceTag;

    const serverName = serverConfig.name;

    yield* logger.debug(`Executing MCP tool: ${serverName}.${toolName}`, { args });

    // Check if server is connected, if not, reconnect (lazy connection)
    const isConnected = yield* mcpManager.isConnected(serverName);
    if (!isConnected) {
      // Show connecting message with spinner
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
      );

      yield* logger.debug(`MCP server ${serverName} not connected, establishing lazy connection...`);

      // Reconnect to the server - provide all required services
      yield* mcpManager.connectServer(serverConfig).pipe(
        Effect.provideService(LoggerServiceTag, logger),
        Effect.provideService(AgentConfigServiceTag, configService),
        Effect.provideService(TerminalServiceTag, terminal),
      );

      // Show success
      yield* terminal.log(
        ink(
          React.createElement(Text, { color: "green" }, `✓ Connected to ${toPascalCase(serverName)} MCP server`),
        ),
      );
      yield* logger.info(`Lazy connection established to MCP server: ${serverName}`);
    }

    // Get server tools
    const mcpTools = yield* mcpManager.getServerTools(serverName);

    // Find the tool by its original MCP name (not the prefixed Jazz name)
    const tool = mcpTools.find((t) => t.name === toolName);

    if (!tool) {
      const availableTools = mcpTools.map((t) => t.name).join(", ");
      return {
        success: false,
        result: null,
        error: `Tool ${toolName} not found in MCP server ${serverName}. Available tools: ${availableTools}`,
      };
    }

    // Execute the tool
    if (!tool.execute) {
      return {
        success: false,
        result: null,
        error: `Tool ${toolName} does not have an execute function`,
      };
    }

    const result = yield* Effect.tryPromise({
      try: () =>
        tool.execute(args, {
          messages: [],
          toolCallId: `${serverName}_${toolName}_${Date.now()}`,
        }),
      catch: (error) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return new MCPToolExecutionError({
          serverName,
          toolName,
          reason: `MCP tool execution failed: ${errorMessage}`,
          cause: error,
          suggestion: `Check that the tool arguments are correct and the MCP server is functioning properly`,
        });
      },
    }).pipe(
      Effect.catchAll((error: unknown) =>
        Effect.gen(function* () {
          let errorMessage: string;
          // Check if it's a TaggedError with _tag property
          if (typeof error === "object" && error !== null && "_tag" in error) {
            const taggedError = error as { _tag: string; reason?: string; message?: string };
            if (taggedError._tag === "MCPToolExecutionError" && taggedError.reason) {
              errorMessage = taggedError.reason;
            } else if (taggedError.message) {
              errorMessage = taggedError.message;
            } else {
              errorMessage = safeStringify(error);
            }
          } else if (error instanceof Error) {
            errorMessage = error.message;
          } else {
            errorMessage = safeStringify(error);
          }
          yield* logger.error(`MCP tool execution failed: ${serverName}.${toolName}`, {
            error: errorMessage,
          });
          // Return error result directly, not wrapped in Effect
          return {
            success: false,
            result: null,
            error: errorMessage,
          } as ToolExecutionResult;
        }),
      ),
    );

    // Handle MCP tool result format
    if (typeof result === "object" && result !== null) {
      const mcpResult = result as {
        content?: unknown;
        isError?: boolean;
      };

      if (mcpResult.isError) {
        const errorContent = mcpResult.content;
        const errorMessage =
          typeof errorContent === "string"
            ? errorContent
            : errorContent instanceof Error
              ? errorContent.message
              : "Unknown error";
        return {
          success: false,
          result: null,
          error: errorMessage,
        };
      }

      return {
        success: true,
        result: mcpResult.content || result,
      };
    }

    return {
      success: true,
      result,
    };
  });
}

/**
 * Register tools from an MCP server
 *
 * @param serverConfig - The MCP server configuration (needed for lazy reconnection)
 * @param mcpTools - The MCP tool definitions from the server
 */
export function registerMCPServerTools(
  serverConfig: MCPServerConfig,
  mcpTools: readonly MCPTool[],
): Effect.Effect<readonly Tool<MCPToolDependencies>[], Error> {
  return Effect.sync(() => {
    const jazzTools: Tool<MCPToolDependencies>[] = [];

    for (const mcpTool of mcpTools) {
      const jazzTool = adaptMCPToolToJazz(serverConfig, {
        name: mcpTool.name,
        description: mcpTool.description,
        inputSchema: mcpTool.inputSchema,
      });
      jazzTools.push(jazzTool);
    }

    return jazzTools;
  });
}
