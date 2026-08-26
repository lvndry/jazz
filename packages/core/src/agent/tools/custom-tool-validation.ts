import type { CustomToolDefinition } from "@/core/types/agent";

/**
 * Pure, framework-agnostic shape validation for a single `CustomToolDefinition`.
 *
 * This is the single source of truth for the per-definition checks (name,
 * description, parameters shape, handler shape) shared between:
 * - `AgentServiceImpl.validateAgentConfig` (`src/services/agent-service.ts`),
 *   which validates the full `customTools` array (including array-level
 *   checks like max length and duplicate names) when an agent config is
 *   created or updated.
 * - `registerCustomToolsForAgent` (`custom-tools.ts`), which re-validates
 *   each selected definition at registration time (every `AgentRunner.run`),
 *   since an agent config can be loaded from a file or other source that
 *   never went through `validateAgentConfig`.
 *
 * Lives in `core/` (not `services/`) so both call sites can use it without
 * `core/` importing from `services/` — the service delegates to this
 * function instead of duplicating the checks.
 */
export interface CustomToolShapeIssue {
  readonly message: string;
  readonly suggestion: string;
}

/**
 * Returns a `CustomToolShapeIssue` describing the first validation problem
 * found, or `null` if `customTool` has a well-formed name, description,
 * parameters schema, and handler.
 */
export function validateCustomToolDefinitionShape(
  customTool: CustomToolDefinition,
): CustomToolShapeIssue | null {
  const { name, description, parameters, handler } = customTool;

  if (typeof name !== "string" || !/^[a-z][a-z0-9_]{1,63}$/.test(name)) {
    return {
      message: `Invalid custom tool name "${String(name)}"`,
      suggestion:
        "Use lowercase letters, digits, and underscores only, starting with a letter, 2-64 characters (e.g. list_files).",
    };
  }

  if (name.startsWith("mcp_")) {
    return {
      message: `Custom tool name "${name}" cannot start with the reserved "mcp_" prefix`,
      suggestion: "Choose a name that does not start with mcp_.",
    };
  }

  if (typeof description !== "string" || description.length < 1 || description.length > 1024) {
    return {
      message: `Custom tool "${name}" description must be a string between 1 and 1024 characters`,
      suggestion: "Provide a short, non-empty description of what the tool does.",
    };
  }

  if (
    typeof parameters !== "object" ||
    parameters === null ||
    Array.isArray(parameters) ||
    parameters["type"] !== "object"
  ) {
    return {
      message: `Custom tool "${name}" parameters must be a JSON Schema object with "type": "object"`,
      suggestion: 'Set parameters to an object schema, e.g. { type: "object", properties: {} }.',
    };
  }

  if (
    typeof handler !== "object" ||
    handler === null ||
    (handler.type !== "record" && handler.type !== "command")
  ) {
    const handlerType =
      typeof handler === "object" && handler !== null && "type" in handler
        ? String((handler as { type: unknown }).type)
        : typeof handler;
    return {
      message: `Custom tool "${name}" handler.type must be "record" or "command" (got "${handlerType}")`,
      suggestion: 'Set handler.type to "record" or "command".',
    };
  }

  if (handler.type === "record") {
    if (
      handler.response !== undefined &&
      (typeof handler.response !== "string" || handler.response.length > 1024)
    ) {
      return {
        message: `Custom tool "${name}" handler.response must be a string of at most 1024 characters`,
        suggestion: "Shorten the fixed response or remove it.",
      };
    }
    return null;
  }

  if (
    !Array.isArray(handler.command) ||
    handler.command.length === 0 ||
    handler.command.some((part) => typeof part !== "string" || part.length === 0)
  ) {
    return {
      message: `Custom tool "${name}" handler.command must be a non-empty array of non-empty strings`,
      suggestion: 'Provide a command like ["ls", "-la"].',
    };
  }

  if (
    handler.timeoutMs !== undefined &&
    (!Number.isInteger(handler.timeoutMs) || handler.timeoutMs <= 0 || handler.timeoutMs > 300_000)
  ) {
    return {
      message: `Custom tool "${name}" handler.timeoutMs must be a positive integer of at most 300000`,
      suggestion: "Set timeoutMs between 1 and 300000 milliseconds, or omit it.",
    };
  }

  return null;
}
