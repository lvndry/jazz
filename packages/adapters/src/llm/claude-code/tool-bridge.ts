/**
 * Exposes Jazz's tools to Claude Code as an in-process MCP server. Claude Code's own built-in
 * tools stay off, so every call the model makes arrives here and is handed to Jazz's tool host,
 * which runs it through the normal executor and approval gate.
 */
import type { ToolHost } from "@jazz/core/types/chat";
import type { ToolCall, ToolDefinition } from "@jazz/core/types/tools";
import { tool, type ToolSet } from "ai";
import { createAiSdkMcpServer } from "ai-sdk-provider-claude-code";
import { z } from "zod";

export const CLAUDE_CODE_MCP_SERVER_NAME = "jazz";
const BRIDGED_TOOL_PREFIX = `mcp__${CLAUDE_CODE_MCP_SERVER_NAME}__`;

/** Whether a tool-call part names a tool Jazz exposed to Claude Code. */
export function isBridgedToolName(toolName: string): boolean {
  return toolName.startsWith(BRIDGED_TOOL_PREFIX);
}

/**
 * Removes `propertyNames`, which a `z.record` emits and Claude Code rejects: a single tool whose
 * schema carries it makes Claude Code drop the whole server's tool list.
 */
function withoutPropertyNames(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(withoutPropertyNames);
  }
  if (node !== null && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node)
        .filter(([key]) => key !== "propertyNames")
        .map(([key, value]) => [key, withoutPropertyNames(value)]),
    );
  }
  return node;
}

function declaresPropertyNames(schema: unknown): boolean {
  return JSON.stringify(schema).includes('"propertyNames"');
}

/**
 * The argument object schema Claude Code needs for a tool. Its MCP bridge accepts only a Zod
 * object, so a tool that advertises plain JSON Schema or a union is converted to one, and one
 * whose schema Claude Code would reject is rebuilt without the offending keyword. A shape that
 * cannot be expressed becomes an open object; Jazz's own validation reports bad arguments.
 */
function bridgeInputSchema(toolDefinition: ToolDefinition): z.ZodObject {
  const parameters = toolDefinition.function.parameters;
  const advertised = toolDefinition.function.jsonSchema ?? z.toJSONSchema(parameters);
  if (parameters instanceof z.ZodObject && !declaresPropertyNames(advertised)) {
    return parameters;
  }
  try {
    const converted = z.fromJSONSchema(
      withoutPropertyNames(advertised) as Parameters<typeof z.fromJSONSchema>[0],
    );
    return converted instanceof z.ZodObject ? converted : z.looseObject({});
  } catch {
    return z.looseObject({});
  }
}

let nextBridgedCallId = 0;

export function bridgeJazzTools(toolDefinitions: readonly ToolDefinition[], toolHost: ToolHost) {
  const toolSet: ToolSet = {};
  for (const toolDefinition of toolDefinitions) {
    const name = toolDefinition.function.name;
    toolSet[name] = tool({
      description: toolDefinition.function.description,
      inputSchema: bridgeInputSchema(toolDefinition),
      execute: async (input: unknown) => {
        nextBridgedCallId += 1;
        const toolCall: ToolCall = {
          id: `claude-code-${nextBridgedCallId}`,
          type: "function",
          function: { name, arguments: JSON.stringify(input ?? {}) },
        };
        const outcome = await toolHost(toolCall);
        const text =
          typeof outcome.result === "string" ? outcome.result : JSON.stringify(outcome.result);
        if (!outcome.success) {
          throw new Error(text);
        }
        return text;
      },
    });
  }
  return {
    mcpServers: {
      [CLAUDE_CODE_MCP_SERVER_NAME]: createAiSdkMcpServer(CLAUDE_CODE_MCP_SERVER_NAME, toolSet),
    },
    allowedTools: Object.keys(toolSet).map((name) => `${BRIDGED_TOOL_PREFIX}${name}`),
  };
}
