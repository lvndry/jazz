import { AgentConfigurationError } from "../../types/errors";

export interface ToolNormalizationOptions {
  readonly agentId?: string;
  readonly field?: string;
}

/**
 * Validates and deduplicates the provided tool configuration (flat array of tool names).
 */
export function normalizeToolConfig(
  value: readonly string[] | undefined,
  options: ToolNormalizationOptions = {},
): readonly string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new AgentConfigurationError({
      agentId: options.agentId ?? "unknown",
      field: options.field ?? "config.tools",
      message: "Tools must be provided as an array of tool names",
      suggestion: "Select tool groups through the CLI or supply an array of tool identifiers.",
    });
  }

  const deduped: string[] = [];
  const seen = new Set<string>();

  value.forEach((entry, index) => {
    if (typeof entry !== "string") {
      throw new AgentConfigurationError({
        agentId: options.agentId ?? "unknown",
        field: `${options.field ?? "config.tools"}[${index}]`,
        message: "Each tool entry must be a string",
      });
    }

    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      throw new AgentConfigurationError({
        agentId: options.agentId ?? "unknown",
        field: `${options.field ?? "config.tools"}[${index}]`,
        message: "Tool names cannot be empty strings",
      });
    }

    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      deduped.push(trimmed);
    }
  });

  return deduped;
}
