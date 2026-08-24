/**
 * MCP (Model Context Protocol) Type Definitions
 *
 * Shapes mirror the wire types in `@modelcontextprotocol/sdk`, narrowed to the
 * fields Jazz reads. They are declared here rather than re-exported so the tool
 * layer does not depend on the SDK's generated Zod inference.
 */

/**
 * Hints a server declares about a tool's blast radius.
 *
 * These are claims a server makes about itself, not guarantees. The spec is
 * explicit that clients must not treat them as trustworthy from an untrusted
 * server, so they only relax Jazz's approval gate for servers the user has
 * marked trusted — see `resolveToolRiskLevel`.
 */
export interface MCPToolAnnotations {
  readonly readOnlyHint?: boolean | undefined;
  readonly destructiveHint?: boolean | undefined;
  readonly idempotentHint?: boolean | undefined;
  readonly openWorldHint?: boolean | undefined;
}

/**
 * MCP tool definition as advertised by `tools/list`.
 *
 * Unlike the previous `@ai-sdk/mcp` shape this carries no `execute`: the raw
 * client dispatches by name through `MCPServerManager.callTool`.
 */
export interface MCPTool {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema?: MCPJSONSchema;
  readonly outputSchema?: MCPJSONSchema;
  readonly annotations?: MCPToolAnnotations;
}

/** A single argument accepted by an MCP prompt. */
export interface MCPPromptArgument {
  readonly name: string;
  readonly description?: string;
  readonly required?: boolean;
}

/**
 * MCP prompt definition as advertised by `prompts/list`.
 *
 * Prompts are user-initiated templates, not model-callable tools; Jazz surfaces
 * them as slash commands.
 */
export interface MCPPrompt {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly arguments?: readonly MCPPromptArgument[];
}

/** One message of a resolved `prompts/get` result. */
export interface MCPPromptMessage {
  readonly role: "user" | "assistant";
  readonly content: unknown;
}

/** Resolved prompt returned by `prompts/get`. */
export interface MCPPromptResult {
  readonly description?: string;
  readonly messages: readonly MCPPromptMessage[];
}

/**
 * Result of `tools/call`.
 *
 * `structuredContent` arrives only from servers that advertise an
 * `outputSchema` (spec 2025-06-18); `content` is the universal fallback.
 */
export interface MCPToolResult {
  readonly content?: unknown;
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

/** Server-declared capabilities captured at initialize time. */
export interface MCPServerCapabilities {
  readonly tools?: { readonly listChanged?: boolean | undefined } | undefined;
  readonly prompts?: { readonly listChanged?: boolean | undefined } | undefined;
  readonly resources?:
    | { readonly listChanged?: boolean | undefined; readonly subscribe?: boolean | undefined }
    | undefined;
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
