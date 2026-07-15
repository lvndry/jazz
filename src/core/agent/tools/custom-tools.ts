import { Effect, Option } from "effect";
import type { z } from "zod";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import { ToolRegistryTag, type Tool, type ToolRegistry } from "@/core/interfaces/tool-registry";
import type { Agent, CustomToolDefinition, CustomToolRecordHandler } from "@/core/types/agent";
import { AgentConfigurationError } from "@/core/types/errors";
import type { ToolCategory, ToolExecutionResult } from "@/core/types/tools";
import { convertMCPSchemaToZod } from "@/core/utils/mcp-schema-converter";
import { defineTool, makeZodValidator } from "./base-tool";

/**
 * Custom-tool registration module
 *
 * Registers agent-declared `customTools` (see `CustomToolDefinition` in
 * `@/core/types/agent`) into the shared `ToolRegistry`, mirroring the shape
 * of `registerMCPToolsForAgent` in `register-tools.ts`.
 *
 * Only the `record` handler is implemented here: it always returns a fixed
 * response with no side effects. `command` handler entries are recognized
 * but intentionally skipped (with a debug log) — that handler ships in a
 * follow-up task.
 */

export const CUSTOM_TOOLS_CATEGORY: ToolCategory = {
  id: "custom_tools",
  displayName: "Custom Tools",
};

/**
 * Build a `Tool` for a `record`-handler custom tool definition.
 *
 * Execution has no side effects: it always succeeds with the handler's fixed
 * `response`, defaulting to `"Recorded."` when omitted.
 */
function buildRecordTool(
  definition: CustomToolDefinition & { readonly handler: CustomToolRecordHandler },
): Tool<never> {
  const parameters = convertMCPSchemaToZod(definition.parameters, definition.name);
  const validate = makeZodValidator(parameters as z.ZodType<Record<string, unknown>>);
  const response = definition.handler.response ?? "Recorded.";

  return {
    ...defineTool<never, Record<string, unknown>>({
      name: definition.name,
      description: definition.description,
      parameters,
      validate,
      handler: (): Effect.Effect<ToolExecutionResult, Error, never> =>
        Effect.succeed({ success: true, result: response }),
    }),
    sourceCustomToolDefinition: definition,
  };
}

/**
 * Structural equality for JSON-like values (the shape `CustomToolDefinition`
 * is restricted to: strings, numbers, booleans, null, arrays, and plain
 * objects). Used to tell whether a re-registration is the exact same custom
 * tool definition, or a genuinely different one that happens to share a name.
 */
function isDeepEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }

  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((item, index) => isDeepEqual(item, right[index]));
  }

  const leftEntries = Object.entries(left as Record<string, unknown>);
  const rightRecord = right as Record<string, unknown>;
  if (leftEntries.length !== Object.keys(rightRecord).length) {
    return false;
  }
  return leftEntries.every(([key, value]) => isDeepEqual(value, rightRecord[key]));
}

/**
 * Register an agent's declared custom tools into the shared `ToolRegistry`.
 *
 * Only entries whose `name` appears in `agentToolNames` are registered — an
 * agent may declare custom tools it doesn't actually expose to itself (e.g.
 * shared config templates). Colliding with an already-registered tool name
 * (builtin or MCP) fails startup with `AgentConfigurationError` rather than
 * silently overriding the existing registration.
 *
 * `command`-handler entries are recognized but skipped (debug log only) —
 * implementing that handler is a follow-up task.
 */
export function registerCustomToolsForAgent(
  agent: Agent,
  agentToolNames: readonly string[],
): Effect.Effect<void, Error, ToolRegistry | LoggerService> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const logger = yield* LoggerServiceTag;

    const customTools = agent.config.customTools ?? [];
    if (customTools.length === 0) {
      return;
    }

    const requestedNames = new Set(agentToolNames);
    const selected = customTools.filter((definition) => requestedNames.has(definition.name));

    if (selected.length === 0) {
      yield* logger.debug(
        "Agent declares custom tools but none are referenced in its tool list, skipping registration",
      );
      return;
    }

    const registeredToolNames = new Set(yield* registry.listAllTools());

    for (const definition of selected) {
      if (registeredToolNames.has(definition.name)) {
        // The ToolRegistry is a session-lifetime singleton and this function
        // runs on every AgentRunner.run (i.e. every chat turn), so seeing the
        // name again is expected — it's not necessarily a collision. Only
        // fail if the existing registration is NOT this same custom-tool
        // definition (a different custom tool, or a builtin/MCP tool).
        const existingTool = yield* registry.getTool(definition.name).pipe(Effect.option);
        const existingDefinition = existingTool.pipe(
          Option.flatMap((tool) => Option.fromNullable(tool.sourceCustomToolDefinition)),
        );

        if (
          Option.isSome(existingDefinition) &&
          isDeepEqual(existingDefinition.value, definition)
        ) {
          yield* logger.debug(
            `Custom tool "${definition.name}" is already registered with an identical definition, skipping re-registration`,
          );
          continue;
        }

        yield* Effect.fail(
          new AgentConfigurationError({
            agentId: agent.id,
            field: "config.customTools",
            message: `Custom tool "${definition.name}" collides with an already-registered tool (builtin or MCP). Rename the custom tool or remove the conflicting one.`,
            suggestion: `Choose a unique name for the "${definition.name}" custom tool.`,
          }),
        );
      }

      if (definition.handler.type === "command") {
        yield* logger.debug(
          `Skipping custom tool "${definition.name}": command handler is not yet implemented`,
        );
        continue;
      }

      const tool = buildRecordTool(
        definition as CustomToolDefinition & { readonly handler: CustomToolRecordHandler },
      );
      yield* registry.registerTool(tool, CUSTOM_TOOLS_CATEGORY);
      registeredToolNames.add(definition.name);

      yield* logger.debug(`Registered custom tool "${definition.name}" (record handler)`);
    }
  });
}
