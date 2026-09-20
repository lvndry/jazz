/**
 * Adapts a plugin-contributed tool declaration into Jazz `Tool`s, mirroring the MCP adapter:
 * externally-defined tools become registry tools whose execution is delegated back to the
 * plugin. Arguments pass through unchanged (the declared JSON Schema is advertised to the model,
 * and the plugin validates its own input), and a non-read-only tool becomes an approval pair so
 * it goes through the host's approval gate like any other risky tool.
 */

import { Effect } from "effect";
import { z } from "zod";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { ToolExecutionResult } from "@/core/types";
import type { PluginToolInfo, PluginToolResult } from "@/core/types/plugin";
import { defineApprovalTool, defineTool, type ToolValidatorResult } from "./base-tool";

/** How the host runs a plugin tool by name; supplied by the caller (a plugin session). */
export type PluginToolInvoker = (
  name: string,
  args: Record<string, unknown>,
) => Effect.Effect<PluginToolResult>;

const APPROVAL_ARGS_PREVIEW_LIMIT = 500;

/** The registry/model-facing name for a plugin tool, namespaced so it never collides. */
export function pluginJazzToolName(pluginId: string, toolName: string): string {
  const slug = pluginId.replace(/[^a-z0-9]+/gi, "_").toLowerCase();
  return `plugin_${slug}_${toolName}`;
}

function passThroughArguments(
  args: Record<string, unknown>,
): ToolValidatorResult<Record<string, unknown>> {
  return { valid: true, value: args };
}

function toExecutionResult(outcome: PluginToolResult): ToolExecutionResult {
  return outcome.isError === true
    ? { success: false, result: outcome.content, error: outcome.content }
    : { success: true, result: outcome.content };
}

function previewArguments(args: Record<string, unknown>): string {
  const serialized = JSON.stringify(args);
  return serialized.length <= APPROVAL_ARGS_PREVIEW_LIMIT
    ? serialized
    : `${serialized.slice(0, APPROVAL_ARGS_PREVIEW_LIMIT)}… (truncated)`;
}

/**
 * Convert one plugin tool declaration into the Jazz tool(s) to register. A read-only tool is a
 * single tool; anything else is an approval pair. `invoke` runs the plugin's handler for this
 * tool by name.
 */
export function adaptPluginToolToJazz(
  info: PluginToolInfo,
  invoke: PluginToolInvoker,
): readonly Tool[] {
  const jazzToolName = pluginJazzToolName(info.pluginId, info.name);
  // The declared JSON Schema is what the model is shown; arguments pass through to the plugin,
  // which owns validation (the schema-to-Zod conversion would be lossy, as with MCP).
  const parameters = z.object({}).passthrough();
  const jsonSchema = info.parameters as Readonly<Record<string, unknown>>;
  const run = (args: Record<string, unknown>): Effect.Effect<ToolExecutionResult> =>
    invoke(info.name, args).pipe(Effect.map(toExecutionResult));

  if (info.riskLevel === "read-only") {
    return [
      defineTool<never, Record<string, unknown>>({
        name: jazzToolName,
        description: info.description,
        disclosure: "private",
        egress: info.egress,
        parameters,
        jsonSchema,
        hidden: false,
        riskLevel: "read-only",
        validate: passThroughArguments,
        handler: (args) => run(args),
      }),
    ];
  }

  return defineApprovalTool<never, Record<string, unknown>>({
    name: jazzToolName,
    description: info.description,
    disclosure: "private",
    egress: info.egress,
    parameters,
    riskLevel: info.riskLevel,
    validate: passThroughArguments,
    approvalMessage: (args) =>
      Effect.succeed(
        [
          `Plugin: ${info.pluginId}`,
          `Tool: ${info.name}`,
          `Arguments: ${previewArguments(args)}`,
        ].join("\n"),
      ),
    handler: (args) => run(args),
  }).all();
}
