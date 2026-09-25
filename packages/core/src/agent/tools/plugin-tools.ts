/**
 * Adapts a plugin-contributed tool declaration into Jazz `Tool`s, mirroring the MCP adapter:
 * externally-defined tools become registry tools whose execution is delegated back to the plugin.
 * The declared JSON Schema is advertised to the model and enforced on the model's arguments before
 * the handler runs, and a non-read-only tool becomes an approval pair so it goes through the host's
 * approval gate like any other risky tool.
 */

import { Effect } from "effect";
import { z } from "zod";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { ToolExecutionResult } from "@/core/types";
import type {
  JsonValue,
  PluginToolInfo,
  PluginToolPreparation,
  PluginToolResult,
} from "@/core/types/plugin";
import { defineTool, type ToolValidator } from "./base-tool";

/** How the host runs a plugin tool by name; supplied by the caller (a plugin session). */
export type PluginToolInvoker = (
  name: string,
  args: Record<string, unknown>,
  context: import("@/core/types").ToolExecutionContext,
) => Effect.Effect<PluginToolResult>;

export interface PluginToolApprovalInvoker {
  readonly run: PluginToolInvoker;
  readonly prepare: (
    name: string,
    args: Record<string, unknown>,
    context: import("@/core/types").ToolExecutionContext,
  ) => Effect.Effect<PluginToolPreparation | PluginToolResult>;
  readonly execute: (
    name: string,
    args: Record<string, unknown>,
    prepared: unknown,
    context: import("@/core/types").ToolExecutionContext,
  ) => Effect.Effect<PluginToolResult>;
}

/** The registry/model-facing name for a plugin tool, namespaced so it never collides. */
export function pluginJazzToolName(pluginId: string, toolName: string): string {
  const slug = pluginId.replace(/[^a-z0-9]+/gi, "_").toLowerCase();
  return `plugin_${slug}_${toolName}`;
}

type JsonSchema = Record<string, unknown>;

function typeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

/**
 * Validate a value against the subset of JSON Schema plugin tools use: type (or type union),
 * enum, object properties/required/additionalProperties, and array items. Unknown keywords are
 * ignored rather than failing, so a richer schema still validates what it can. Collects human
 * error strings; empty means valid.
 */
function collectSchemaErrors(
  value: unknown,
  schema: JsonSchema,
  path: string,
  errors: string[],
): void {
  const label = path.length > 0 ? path : "value";
  const type = schema["type"];
  if (typeof type === "string" && !typeMatches(value, type)) {
    errors.push(`${label} must be ${type}`);
    return;
  }
  if (
    Array.isArray(type) &&
    !type.some((candidate) => typeof candidate === "string" && typeMatches(value, candidate))
  ) {
    errors.push(`${label} must be one of: ${type.join(", ")}`);
    return;
  }
  const enumValues = schema["enum"];
  if (Array.isArray(enumValues) && !enumValues.some((allowed) => allowed === value)) {
    errors.push(`${label} must be one of the allowed values`);
  }
  if (typeMatches(value, "object") && (type === "object" || schema["properties"] !== undefined)) {
    const object = value as Record<string, unknown>;
    const properties = (schema["properties"] as Record<string, JsonSchema> | undefined) ?? {};
    const required = Array.isArray(schema["required"]) ? (schema["required"] as string[]) : [];
    for (const key of required) {
      if (!(key in object)) errors.push(`${path.length > 0 ? `${path}.` : ""}${key} is required`);
    }
    if (schema["additionalProperties"] === false) {
      for (const key of Object.keys(object)) {
        if (!(key in properties)) {
          errors.push(`${path.length > 0 ? `${path}.` : ""}${key} is not an allowed property`);
        }
      }
    }
    for (const [key, subschema] of Object.entries(properties)) {
      if (key in object) {
        collectSchemaErrors(
          object[key],
          subschema,
          path.length > 0 ? `${path}.${key}` : key,
          errors,
        );
      }
    }
  }
  if (typeMatches(value, "array") && schema["items"] !== undefined) {
    const items = schema["items"] as JsonSchema;
    (value as readonly unknown[]).forEach((element, index) =>
      collectSchemaErrors(element, items, `${label}[${index}]`, errors),
    );
  }
}

/**
 * A validator that checks the model's arguments against a plugin tool's declared JSON Schema before
 * the handler runs. A non-object schema (nothing to enforce) passes through unchanged.
 */
function makeArgumentValidator(schema: JsonValue): ToolValidator<Record<string, unknown>> {
  const isObjectSchema = typeof schema === "object" && schema !== null && !Array.isArray(schema);
  return (args) => {
    if (!isObjectSchema) return { valid: true, value: args };
    const errors: string[] = [];
    collectSchemaErrors(args, schema as JsonSchema, "", errors);
    return errors.length === 0 ? { valid: true, value: args } : { valid: false, errors };
  };
}

function toExecutionResult(outcome: PluginToolResult): ToolExecutionResult {
  return outcome.isError === true
    ? { success: false, result: outcome.content, error: outcome.content }
    : { success: true, result: outcome.content };
}

/**
 * Convert one plugin tool declaration into the Jazz tool(s) to register. A read-only tool is a
 * single tool; anything else is an approval pair. `invoke` runs the plugin's handler for this
 * tool by name.
 */
export function adaptPluginToolToJazz(
  info: PluginToolInfo,
  invoke: PluginToolApprovalInvoker,
): readonly Tool[] {
  const jazzToolName = pluginJazzToolName(info.pluginId, info.name);
  // The model is shown the declared JSON Schema (jsonSchema below); the Zod parameters stay open
  // because the enforced gate is makeArgumentValidator, run against that same declared schema.
  const parameters = z.object({}).passthrough();
  const jsonSchema = info.parameters as Readonly<Record<string, unknown>>;
  const run = (
    args: Record<string, unknown>,
    context: import("@/core/types").ToolExecutionContext,
  ): Effect.Effect<ToolExecutionResult> =>
    invoke.run(info.name, args, context).pipe(Effect.map(toExecutionResult));

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
        validate: makeArgumentValidator(info.parameters),
        handler: (args, context) => run(args, context),
      }),
    ];
  }

  const executeToolName = `execute_${jazzToolName}`;
  const approval = defineTool<never, Record<string, unknown>>({
    name: jazzToolName,
    description: info.description,
    disclosure: "private",
    egress: info.egress,
    parameters,
    jsonSchema,
    riskLevel: info.riskLevel,
    validate: makeArgumentValidator(info.parameters),
    approvalExecuteToolName: executeToolName,
    handler: (args, context) =>
      invoke.prepare(info.name, args, context).pipe(
        Effect.map((proposal) => {
          if ("isError" in proposal && proposal.isError === true)
            return toExecutionResult(proposal);
          if (!("message" in proposal))
            return { success: false, result: proposal.content, error: proposal.content };
          return {
            success: false,
            result: {
              approvalRequired: true,
              message: proposal.message,
              previewDiff: proposal.previewDiff,
              executeToolName,
              executeArgs: { args, prepared: proposal.prepared },
            },
            error: `Approval required: ${jazzToolName} requires user confirmation.`,
          };
        }),
      ),
  });
  const execute = defineTool<never, { args: Record<string, unknown>; prepared: unknown }>({
    name: executeToolName,
    description: `Performs approved plugin tool ${info.name}.`,
    hidden: true,
    disclosure: "private",
    egress: info.egress,
    parameters: z.object({ args: z.record(z.string(), z.unknown()), prepared: z.unknown() }),
    riskLevel: info.riskLevel,
    handler: ({ args, prepared }, context) =>
      invoke.execute(info.name, args, prepared, context).pipe(Effect.map(toExecutionResult)),
  });
  return [approval, execute];
}
