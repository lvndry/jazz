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

/** A resource a server exposes by URI, as advertised by `resources/list`. */
export interface MCPResource {
  readonly uri: string;
  readonly name?: string | undefined;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly mimeType?: string | undefined;
}

/** One block of a `resources/read` result. */
export interface MCPResourceContent {
  readonly uri: string;
  readonly mimeType?: string | undefined;
  /** Text body, present for textual resources. */
  readonly text?: string | undefined;
  /** Base64 body, present for binary resources. */
  readonly blob?: string | undefined;
}

/**
 * A field an elicitation asks the user to fill.
 *
 * Narrowed from the spec's `PrimitiveSchemaDefinition` to what a terminal can
 * actually render: a line of text, a number, a yes/no, or a choice from a list.
 */
export interface MCPElicitationField {
  readonly name: string;
  readonly type: "string" | "number" | "integer" | "boolean" | "enum" | "multi-enum";
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly required: boolean;
  /** Present when `type` is "enum" or "multi-enum". */
  readonly options?: readonly { readonly value: string; readonly label: string }[] | undefined;
  readonly default?: string | number | boolean | readonly string[] | undefined;
}

/** A server's request for structured input from the user. */
export interface MCPElicitationRequest {
  readonly serverName: string;
  readonly message: string;
  readonly fields: readonly MCPElicitationField[];
}

/**
 * The user's answer to an elicitation.
 *
 * `decline` means "no, continue without this"; `cancel` means the user
 * dismissed the request entirely. The spec distinguishes them and servers are
 * expected to react differently, so Jazz does not collapse the two.
 */
export type MCPElicitationResponse =
  | {
      readonly action: "accept";
      readonly content: Record<string, string | number | boolean | readonly string[]>;
    }
  | { readonly action: "decline" }
  | { readonly action: "cancel" };

/** A parameterized resource URI, as advertised by `resources/templates/list`. */
export interface MCPResourceTemplate {
  readonly uriTemplate: string;
  readonly name?: string | undefined;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly mimeType?: string | undefined;
}

/** One progress report from a long-running server operation. */
export interface MCPProgress {
  readonly progress: number;
  readonly total?: number | undefined;
  readonly message?: string | undefined;
}
