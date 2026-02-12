/**
 * MCP (Model Context Protocol) Type Definitions
 *
 * These types provide type safety for MCP client interactions.
 * The @ai-sdk/mcp library doesn't export all types, so we define
 * compatible interfaces based on the actual runtime behavior.
 */

/**
 * MCP Tool Definition
 * Represents a tool that can be executed on an MCP server
 */
export interface MCPTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: MCPJSONSchema;
  readonly execute: (args: unknown, context: MCPToolContext) => Promise<MCPToolResult>;
}

/**
 * MCP Tool Execution Context
 */
export interface MCPToolContext {
  readonly messages?: readonly unknown[];
  readonly toolCallId?: string;
}

/**
 * MCP Tool Execution Result
 */
export interface MCPToolResult {
  readonly content?: unknown;
  readonly isError?: boolean;
}

/**
 * MCP Tool Registry
 * Can be either an array of tools or an object mapping tool names to tool definitions
 */
export type MCPToolRegistry = readonly MCPTool[] | Record<string, MCPTool>;

/**
 * MCP Client Interface
 * Represents the client returned by @ai-sdk/mcp's createMCPClient
 */
export interface MCPClient {
  readonly tools: () => Promise<MCPToolRegistry>;
  readonly close?: () => Promise<void>;
}

/**
 * JSON Schema types for MCP tool input schemas
 */
export interface MCPJSONSchema {
  readonly type?: string | readonly string[];
  readonly properties?: Record<string, MCPJSONSchema>;
  readonly required?: readonly string[];
  readonly items?: MCPJSONSchema;
  readonly enum?: readonly unknown[];
  readonly description?: string;
  readonly oneOf?: readonly MCPJSONSchema[];
  readonly anyOf?: readonly MCPJSONSchema[];
  readonly allOf?: readonly MCPJSONSchema[];
  readonly additionalProperties?: boolean | MCPJSONSchema;
  readonly $ref?: string;
  readonly const?: unknown;
}

/**
 * Type guard to check if a value is an MCPTool
 */
export function isMCPTool(value: unknown): value is MCPTool {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof (value as { name: unknown }).name === "string" &&
    "execute" in value &&
    typeof (value as { execute: unknown }).execute === "function"
  );
}

/**
 * Type guard to check if a value is an MCPClient
 */
export function isMCPClient(value: unknown): value is MCPClient {
  return (
    typeof value === "object" &&
    value !== null &&
    "tools" in value &&
    typeof (value as { tools: unknown }).tools === "function"
  );
}

/**
 * Type guard to check if a value is an array of MCPTools
 */
export function isMCPToolArray(value: unknown): value is readonly MCPTool[] {
  return Array.isArray(value) && value.every(isMCPTool);
}

/**
 * Type guard to check if a value is a tool registry object
 */
/**
 * Check if a value looks like a tool definition (without execute function)
 * Tool definitions from MCP servers typically have description, inputSchema, or title
 */
function isMCPToolDefinition(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const toolDef = value as {
    description?: unknown;
    inputSchema?: unknown;
    title?: unknown;
  };

  const hasDescription = typeof toolDef.description === "string";
  const hasInputSchema = typeof toolDef.inputSchema === "object" && toolDef.inputSchema !== null;
  const hasTitle = typeof toolDef.title === "string";

  return hasDescription || hasInputSchema || hasTitle;
}

/**
 * Type guard to check if a value is a tool registry object
 * A tool registry object maps tool names to either MCPTool instances or tool definitions
 */
export function isMCPToolRegistryObject(value: unknown): value is Record<string, MCPTool> {
  // Must be a non-null object (not an array)
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  // Check if at least one value looks like a tool or tool definition
  const registryValues = Object.values(value);
  const hasValidTool = registryValues.some((toolValue) => {
    // Check if it's a complete MCPTool with execute function
    if (isMCPTool(toolValue)) {
      return true;
    }
    // Check if it's a tool definition (description/inputSchema without execute)
    return isMCPToolDefinition(toolValue);
  });

  return hasValidTool;
}

/**
 * Normalize a tool registry to an array of tools
 * Handles both array and object registry formats
 */
export function normalizeMCPToolRegistry(registry: MCPToolRegistry): readonly MCPTool[] {
  if (isMCPToolArray(registry)) {
    return registry;
  }

  if (isMCPToolRegistryObject(registry)) {
    const tools: MCPTool[] = [];
    for (const [toolName, toolDef] of Object.entries(registry)) {
      if (isMCPTool(toolDef)) {
        // Tool already has execute function - use as-is
        tools.push({
          ...toolDef,
          name: toolDef.name || toolName,
        });
      } else if (typeof toolDef === "object" && toolDef !== null) {
        // Handle tool definitions that may not have execute functions yet
        // (execute functions are provided by the MCP client when tools are called)
        const toolObj = toolDef as {
          name?: string;
          description?: string;
          inputSchema?: unknown;
          execute?: unknown;
          title?: string;
          [key: string]: unknown;
        };

        // Check if it has an execute function
        if (typeof toolObj.execute === "function") {
          // Tool has execute function - create full MCPTool
          const toolNameValue = toolObj.name || toolName;
          const toolExecute = toolObj.execute as MCPTool["execute"];

          const mcpTool: MCPTool = {
            name: toolNameValue,
            execute: toolExecute,
            ...(typeof toolObj.description === "string" && { description: toolObj.description }),
            ...(toolObj.inputSchema !== undefined &&
              toolObj.inputSchema !== null && {
                inputSchema: toolObj.inputSchema as MCPJSONSchema,
              }),
          };

          tools.push(mcpTool);
        } else {
          // Tool definition without execute function - create stub execute
          // The actual execution will be handled by the MCP client when the tool is called
          // The name comes from the object key if not present in the tool definition
          const finalToolName = toolObj.name || toolObj.title || toolName;

          const mcpTool: MCPTool = {
            name: finalToolName,
            // Stub execute function - will be replaced when tool is actually called via getServerTools
            // This is just for type compatibility during discovery
            execute: () => {
              return Promise.reject(
                new Error(
                  `Tool ${finalToolName} execute function not available during discovery. The actual execute function will be provided by the MCP client when the tool is called.`,
                ),
              );
            },
            ...(typeof toolObj.description === "string" && { description: toolObj.description }),
            ...(toolObj.inputSchema !== undefined &&
              toolObj.inputSchema !== null && {
                inputSchema: toolObj.inputSchema as MCPJSONSchema,
              }),
          };

          tools.push(mcpTool);
        }
      }
    }
    return tools.length > 0 ? tools : Object.values(registry).filter(isMCPTool);
  }

  return [];
}
