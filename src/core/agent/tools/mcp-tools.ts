import { Effect } from "effect";
import { z } from "zod";
import type { AgentConfigService } from "@/core/interfaces/agent-config";
import type { LoggerService } from "@/core/interfaces/logger";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import type { MCPServerConfig, MCPServerManager } from "@/core/interfaces/mcp-server";
import { MCPServerManagerTag } from "@/core/interfaces/mcp-server";
import type { PresentationService } from "@/core/interfaces/presentation";
import { PresentationServiceTag } from "@/core/interfaces/presentation";
import type { TerminalService } from "@/core/interfaces/terminal";
import type { Tool, ToolRiskLevel } from "@/core/interfaces/tool-registry";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";
import type {
  MCPProgress,
  MCPResourceContent,
  MCPTool,
  MCPToolAnnotations,
} from "@/core/types/mcp";
import { convertMCPSchemaToZod, unwrapMCPJsonSchema } from "@/core/utils/mcp-schema-converter";
import { safeStringify, toPascalCase } from "@/core/utils/string";
import { defineApprovalTool, defineTool, type ToolValidatorResult } from "./base-tool";

/**
 * MCP Tool Dependencies - all services needed for MCP tool operations
 */
export type MCPToolDependencies =
  AgentConfigService | LoggerService | MCPServerManager | TerminalService | PresentationService;

/**
 * Minimum gap between progress lines shown for one tool call.
 *
 * A server is free to report every few milliseconds; the point of showing
 * progress is that the call is alive, which one line per second conveys as
 * well as thirty do.
 */
const PROGRESS_THROTTLE_MS = 1000;

/** How much of an argument blob to show in an approval prompt. */
const APPROVAL_ARGS_PREVIEW_LIMIT = 500;

/**
 * Ceiling on entries returned by a resource listing.
 *
 * Chosen to stay well under a single screen's worth of context: a server may
 * advertise thousands of resources, and the listing is a means of finding one,
 * not content worth spending the window on.
 */
const RESOURCE_LIST_LIMIT = 100;

/**
 * Ceiling on the text returned by a single resource read.
 *
 * The model picks a URI, not a size, and a server is free to back one URI with
 * a whole file. Truncating with a visible marker keeps a large resource
 * useful instead of letting it swallow the conversation.
 */
const RESOURCE_READ_CHAR_LIMIT = 100_000;

/** An object schema that keeps every key the model supplied. */
function emptyPassthroughObject(): z.ZodTypeAny {
  return z.object({}).passthrough();
}

/**
 * Detect the permissive schema `convertMCPSchemaToZod` degrades to.
 *
 * Zod 3 reports this as `_def.typeName`, Zod 4 as `_def.type`, so both are
 * checked — reading only one silently disables the fallback on the other major.
 */
function isZodUnknown(schema: z.ZodTypeAny): boolean {
  const def = (schema as { _def?: { typeName?: string; type?: string } })._def;
  return def?.typeName === "ZodUnknown" || def?.type === "unknown";
}

/**
 * Forward MCP arguments untouched.
 *
 * `convertMCPSchemaToZod` is lossy — `$ref` is unresolved, an untyped property
 * degrades to an object schema, and a plain `z.object` strips keys it does not
 * name. Validating against it would reject or silently empty calls the server
 * would have accepted, so the server's own schema stays authoritative and its
 * error is what the model sees.
 */
function passThroughMCPArguments(
  args: Record<string, unknown>,
): ToolValidatorResult<Record<string, unknown>> {
  return { valid: true, value: args };
}

/**
 * Decide how much a tool has to justify itself before it runs.
 *
 * Annotations are a server describing its own blast radius, and the spec is
 * explicit that a client must not take them as guarantees from a server it does
 * not trust — a hostile server would simply mark its destructive tools
 * `readOnlyHint`. So they only ever relax the gate for a server the user has
 * marked trusted; for anyone else every tool is treated as high-risk regardless
 * of what it claims.
 */
export function resolveToolRiskLevel(
  annotations: MCPToolAnnotations | undefined,
  trusted: boolean,
): ToolRiskLevel {
  if (!trusted) return "high-risk";
  if (annotations?.readOnlyHint === true) return "read-only";
  if (annotations?.destructiveHint === true) return "high-risk";
  return "low-risk";
}

/** One-line summary of what a tool call would touch, for the approval prompt. */
function describeAnnotations(annotations: MCPToolAnnotations | undefined): string | undefined {
  if (!annotations) return undefined;
  const labels: string[] = [];
  if (annotations.readOnlyHint === true) labels.push("read-only");
  if (annotations.destructiveHint === true) labels.push("destructive");
  if (annotations.idempotentHint === true) labels.push("idempotent");
  if (annotations.openWorldHint === true) labels.push("open-world");
  return labels.length > 0 ? labels.join(", ") : undefined;
}

function previewArguments(args: Record<string, unknown>): string {
  const serialized = safeStringify(args);
  if (serialized.length <= APPROVAL_ARGS_PREVIEW_LIMIT) return serialized;
  return `${serialized.slice(0, APPROVAL_ARGS_PREVIEW_LIMIT)}… (truncated)`;
}

/** Parameter schema for an MCP tool, tolerant of servers with no usable schema. */
function resolveParameters(inputSchema: unknown): z.ZodTypeAny {
  if (inputSchema === undefined || inputSchema === null) {
    return emptyPassthroughObject();
  }

  const converted = convertMCPSchemaToZod(inputSchema, "mcp_tool");
  return isZodUnknown(converted) ? emptyPassthroughObject() : converted;
}

/**
 * Make sure the server is connected, reconnecting if the session dropped it.
 *
 * Returns undefined on success, or the failed tool result to hand straight
 * back to the model.
 */
function ensureConnected(
  serverConfig: MCPServerConfig,
): Effect.Effect<ToolExecutionResult | undefined, never, MCPToolDependencies> {
  return Effect.gen(function* () {
    const mcpManager = yield* MCPServerManagerTag;
    const presentation = yield* PresentationServiceTag;
    const serverName = serverConfig.name;

    const isConnected = yield* mcpManager.isConnected(serverName);
    if (isConnected) return undefined;

    yield* presentation.presentStatus(
      `Connecting to ${toPascalCase(serverName)} MCP server...`,
      "progress",
    );

    const connectResult = yield* Effect.either(mcpManager.connectServer(serverConfig));
    if (connectResult._tag === "Left") {
      const error = connectResult.left;
      yield* presentation.presentStatus(
        `Failed to connect to ${toPascalCase(serverName)} MCP server`,
        "warning",
      );
      return {
        success: false,
        result: null,
        error: `${error.reason}${error.suggestion ? ` — ${error.suggestion}` : ""}`,
      };
    }

    yield* presentation.presentStatus(
      `Connected to ${toPascalCase(serverName)} MCP server`,
      "success",
    );

    return undefined;
  });
}

/**
 * Run one MCP tool, connecting the server first if the session dropped it.
 */
function executeMCPTool(
  serverConfig: MCPServerConfig,
  toolName: string,
  args: Record<string, unknown>,
): Effect.Effect<ToolExecutionResult, Error, MCPToolDependencies> {
  return Effect.gen(function* () {
    const mcpManager = yield* MCPServerManagerTag;
    const logger = yield* LoggerServiceTag;

    const serverName = serverConfig.name;

    yield* logger.debug(`Executing MCP tool: ${serverName}.${toolName}`, { args });

    const connectionFailure = yield* ensureConnected(serverConfig);
    if (connectionFailure !== undefined) return connectionFailure;

    const presentation = yield* PresentationServiceTag;

    // Without this a server doing thirty seconds of work is indistinguishable
    // from one that has hung. Reports arrive on the transport's callback rather
    // than inside this fiber, hence the detached run.
    let lastShownAt = 0;
    const reportProgress = (progress: MCPProgress): void => {
      const now = Date.now();
      const isFinal = progress.total !== undefined && progress.progress >= progress.total;
      if (!isFinal && now - lastShownAt < PROGRESS_THROTTLE_MS) return;
      lastShownAt = now;

      const share =
        progress.total !== undefined && progress.total > 0
          ? ` ${Math.round((progress.progress / progress.total) * 100)}%`
          : "";
      const detail = progress.message !== undefined ? ` — ${progress.message}` : "";

      void Effect.runPromise(
        presentation
          .presentStatus(`${toolName}${share}${detail}`, "progress")
          .pipe(Effect.catchAllCause(() => Effect.void)),
      );
    };

    const callResult = yield* Effect.either(
      mcpManager.callTool(serverName, toolName, args, reportProgress),
    );

    if (callResult._tag === "Left") {
      const error = callResult.left;
      yield* logger.error(`MCP tool execution failed: ${serverName}.${toolName}`, {
        error: error.reason,
      });
      return { success: false, result: null, error: error.reason };
    }

    const result = callResult.right;

    if (result.isError === true) {
      const content = result.content;
      return {
        success: false,
        result: null,
        error: typeof content === "string" ? content : safeStringify(content ?? "Unknown error"),
      };
    }

    // A server that advertises an `outputSchema` returns the parsed object in
    // `structuredContent`; `content` is then just its text rendering, so the
    // structured form is what the model should reason over.
    return {
      success: true,
      result: result.structuredContent ?? result.content ?? null,
    };
  });
}

/**
 * Adapt one MCP tool to Jazz's tool model.
 *
 * Returns one tool for calls that need no confirmation, or an approval/execute
 * pair for everything else. The split has to happen here rather than through a
 * risk level alone: the approval gate in the executor fires on the sentinel
 * `defineApprovalTool` returns, so a tool registered as a plain tool runs
 * ungated no matter what risk level it carries.
 */
function adaptMCPToolToJazz(
  serverConfig: MCPServerConfig,
  mcpTool: MCPTool,
): readonly Tool<MCPToolDependencies>[] {
  const jazzToolName = `mcp_${serverConfig.name.toLowerCase()}_${mcpTool.name}`;
  const mcpToolName = mcpTool.name;
  const parameters = resolveParameters(mcpTool.inputSchema);
  const unwrappedJsonSchema = unwrapMCPJsonSchema(mcpTool.inputSchema);
  const description = mcpTool.description || `MCP tool: ${mcpToolName}`;
  const riskLevel = resolveToolRiskLevel(mcpTool.annotations, serverConfig.trusted === true);

  if (riskLevel === "read-only") {
    return [
      defineTool<MCPToolDependencies, Record<string, unknown>>({
        name: jazzToolName,
        // Defined outside this codebase: its output is unknowable, and the safe
        // reading of "unknown" is the most restrictive level.
        disclosure: "personal",
        description,
        parameters,
        ...(unwrappedJsonSchema !== undefined ? { jsonSchema: unwrappedJsonSchema } : {}),
        hidden: false,
        riskLevel,
        validate: passThroughMCPArguments,
        handler: (args: Record<string, unknown>) => executeMCPTool(serverConfig, mcpToolName, args),
      }),
    ];
  }

  const annotationSummary = describeAnnotations(mcpTool.annotations);

  const pair = defineApprovalTool<MCPToolDependencies, Record<string, unknown>>({
    name: jazzToolName,
    // Defined outside this codebase: its output is unknowable, and the safe
    // reading of "unknown" is the most restrictive level.
    disclosure: "personal",
    description,
    parameters,
    riskLevel,
    validate: passThroughMCPArguments,
    approvalMessage: (args: Record<string, unknown>, _context: ToolExecutionContext) =>
      Effect.succeed(
        [
          `MCP server: ${toPascalCase(serverConfig.name)}${serverConfig.trusted === true ? " (trusted)" : ""}`,
          `Tool: ${mcpToolName}`,
          ...(annotationSummary ? [`Declared: ${annotationSummary}`] : []),
          `Arguments: ${previewArguments(args)}`,
        ].join("\n"),
      ),
    handler: (args: Record<string, unknown>) => executeMCPTool(serverConfig, mcpToolName, args),
  });

  return pair.all();
}

/** Render one resource block as text the model can read. */
function renderResourceContent(content: MCPResourceContent): string {
  if (content.text !== undefined) return content.text;
  if (content.blob !== undefined) {
    return `[binary resource ${content.mimeType ?? "of unknown type"}, ${content.blob.length} base64 chars — not inlined]`;
  }
  return "[empty resource]";
}

/**
 * Build the pair of tools that let the model reach a server's resources.
 *
 * Resources are application-controlled in the spec — the host picks what enters
 * context — but a terminal has no attach menu, so exposing them as tools is how
 * they become usable at all. Both are registered read-only without consulting
 * trust: unlike a tool's `readOnlyHint`, which is a server's claim about
 * itself, `resources/read` is read-only by protocol definition.
 */
export function buildResourceTools(
  serverConfig: MCPServerConfig,
): readonly Tool<MCPToolDependencies>[] {
  const serverName = serverConfig.name;
  const prefix = `mcp_${serverName.toLowerCase()}`;

  const listTool = defineTool<MCPToolDependencies, Record<string, unknown>>({
    name: `${prefix}_list_resources`,
    description: `List resources available from the ${toPascalCase(serverName)} MCP server. Returns each resource's URI, name, and description. Narrow a large catalogue with "filter" rather than paging through it, then read one with ${prefix}_read_resource.`,
    parameters: z.object({
      filter: z
        .string()
        .optional()
        .describe("Case-insensitive substring matched against URI, name, and description"),
      limit: z
        .number()
        .optional()
        .describe(`Maximum entries to return (default and maximum ${RESOURCE_LIST_LIMIT})`),
    }),
    hidden: false,
    riskLevel: "read-only",
    disclosure: "personal",
    handler: (args: Record<string, unknown>) =>
      Effect.gen(function* () {
        const mcpManager = yield* MCPServerManagerTag;

        const connected = yield* ensureConnected(serverConfig);
        if (connected !== undefined) return connected;

        const resources = yield* Effect.either(mcpManager.getServerResources(serverName));
        if (resources._tag === "Left") {
          return { success: false, result: null, error: resources.left.reason };
        }

        const filter =
          typeof args["filter"] === "string" ? args["filter"].toLowerCase() : undefined;
        const matched =
          filter === undefined
            ? resources.right
            : resources.right.filter((resource) =>
                [resource.uri, resource.name, resource.title, resource.description]
                  .filter((value): value is string => typeof value === "string")
                  .some((value) => value.toLowerCase().includes(filter)),
              );

        // A server's catalogue is its own business and can run to thousands of
        // entries; returning all of them would spend the context window on a
        // directory listing. Hosts that surface resources in a picker keep this
        // list out of the model entirely — a cap is the equivalent here.
        const requested =
          typeof args["limit"] === "number" && Number.isFinite(args["limit"])
            ? Math.max(1, Math.floor(args["limit"]))
            : RESOURCE_LIST_LIMIT;
        const limit = Math.min(requested, RESOURCE_LIST_LIMIT);
        const shown = matched.slice(0, limit);

        return {
          success: true,
          result: {
            resources: shown,
            total: resources.right.length,
            ...(filter !== undefined ? { matched: matched.length } : {}),
            ...(matched.length > shown.length
              ? {
                  truncated: `Showing ${shown.length} of ${matched.length}. Narrow the results with "filter".`,
                }
              : {}),
          },
        };
      }),
  });

  const readTool = defineTool<MCPToolDependencies, Record<string, unknown>>({
    name: `${prefix}_read_resource`,
    description: `Read one resource from the ${toPascalCase(serverName)} MCP server by its URI. Call ${prefix}_list_resources first to discover URIs.`,
    parameters: z.object({
      uri: z.string().describe("The resource URI, exactly as advertised by the server"),
    }),
    hidden: false,
    riskLevel: "read-only",
    disclosure: "personal",
    handler: (args: Record<string, unknown>) =>
      Effect.gen(function* () {
        const mcpManager = yield* MCPServerManagerTag;
        const uri = typeof args["uri"] === "string" ? args["uri"] : "";

        if (uri === "") {
          return { success: false, result: null, error: "A resource uri is required." };
        }

        const connected = yield* ensureConnected(serverConfig);
        if (connected !== undefined) return connected;

        const contents = yield* Effect.either(mcpManager.readResource(serverName, uri));
        if (contents._tag === "Left") {
          return { success: false, result: null, error: contents.left.reason };
        }

        const rendered = contents.right.map(renderResourceContent).join("\n\n");

        return {
          success: true,
          result:
            rendered.length > RESOURCE_READ_CHAR_LIMIT
              ? `${rendered.slice(0, RESOURCE_READ_CHAR_LIMIT)}\n\n[truncated — resource is ${rendered.length} characters, showing the first ${RESOURCE_READ_CHAR_LIMIT}]`
              : rendered,
        };
      }),
  });

  return [listTool, readTool];
}

/**
 * Build Jazz tools for every tool an MCP server advertises.
 *
 * @param serverConfig - The MCP server configuration (needed for lazy reconnection)
 * @param mcpTools - The MCP tool definitions from the server
 */
export function registerMCPServerTools(
  serverConfig: MCPServerConfig,
  mcpTools: readonly MCPTool[],
): Effect.Effect<readonly Tool<MCPToolDependencies>[], Error> {
  return Effect.sync(() =>
    mcpTools.flatMap((mcpTool) => adaptMCPToolToJazz(serverConfig, mcpTool)),
  );
}
