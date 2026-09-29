/**
 * What is wrong with an agent file that still loads.
 *
 * An agent with a misspelled provider (`opneai`), an unknown reasoning level,
 * or a tool name nothing provides reads fine from disk and fails only when
 * someone chats with it. `agentConfigProblems` names those problems up front so
 * `jazz agent list` can warn and `jazz config validate` can fail.
 */

import { AVAILABLE_PROVIDERS } from "@/core/constants/models";
import type { Agent } from "@/core/types/index";
import { isReasoningSelection } from "@/core/types/model-capabilities";
import { unknownProviderMessage } from "@/core/utils/provider-model";
import { closestMatch } from "@/core/utils/string";

/** An error stops the agent from running; a warning is worth a look. */
export interface AgentConfigProblem {
  readonly field: string;
  readonly message: string;
  readonly severity: "error" | "warning";
}

/**
 * MCP tools are registered as `mcp_<server>_<tool>` when their server connects,
 * so they are never among the built-ins a check can see.
 */
const MCP_TOOL_PREFIX = "mcp_";

/**
 * Problems with one agent's configuration.
 *
 * @param builtinToolNames - The built-in tools, when the caller has a registry
 *   to ask. Without it tools are not checked. A tool that is not built in
 *   can still come from an MCP server, a plugin, or a custom tool, so it is a
 *   warning, not an error.
 */
export function agentConfigProblems(
  agent: Agent,
  builtinToolNames?: ReadonlySet<string>,
): readonly AgentConfigProblem[] {
  const problems: AgentConfigProblem[] = [];
  const provider = agent.config.llm.provider;
  if (!AVAILABLE_PROVIDERS.includes(provider)) {
    problems.push({
      field: "config.llm.provider",
      message: unknownProviderMessage(String(provider)),
      severity: "error",
    });
  }

  const reasoning = agent.config.llm.reasoning;
  if (reasoning !== undefined && !isReasoningSelection(reasoning)) {
    problems.push({
      field: "config.llm.reasoning",
      message: `"${String(reasoning)}" is not a reasoning level. Use disable, minimal, low, medium, high, xhigh, or max.`,
      severity: "error",
    });
  }

  if (builtinToolNames !== undefined) {
    for (const tool of agent.config.tools ?? []) {
      if (builtinToolNames.has(tool) || tool.startsWith(MCP_TOOL_PREFIX)) {
        continue;
      }
      const suggestion = closestMatch(tool, [...builtinToolNames]);
      problems.push({
        field: "config.tools",
        message:
          `"${tool}" is not a built-in tool.` +
          (suggestion === undefined ? "" : ` Did you mean "${suggestion}"?`) +
          " Ignore this if an MCP server, plugin, or custom tool provides it.",
        severity: "warning",
      });
    }
  }
  return problems;
}
