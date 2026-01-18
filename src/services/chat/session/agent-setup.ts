import { Effect } from "effect";
import { registerMCPToolsForAgent } from "../../../core/agent/tools/register-tools";
import { normalizeToolConfig } from "../../../core/agent/utils/tool-config";
import type { AgentConfigService } from "../../../core/interfaces/agent-config";
import { LoggerServiceTag, type LoggerService } from "../../../core/interfaces/logger";
import type { MCPServerManager } from "../../../core/interfaces/mcp-server";
import { TerminalServiceTag, type TerminalService } from "../../../core/interfaces/terminal";
import type { ToolRegistry } from "../../../core/interfaces/tool-registry";
import type { Agent } from "../../../core/types";

/**
 * Set up agent before first message: Connect to MCP servers and register tools.
 *
 * This happens as part of "agent setup" phase before the chat loop starts.
 * MCP connections are established early so tools are available when needed.
 * If some MCP connections fail (e.g., invalid credentials), we show a warning
 * but continue the conversation - the agent can still use other available tools.
 */
export function setupAgent(
  agent: Agent,
  sessionId: string,
): Effect.Effect<
  void,
  never,
  | ToolRegistry
  | MCPServerManager
  | AgentConfigService
  | LoggerService
  | TerminalService
> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const terminal = yield* TerminalServiceTag;
    yield* logger.setSessionId(sessionId);

    // Get agent's tool names
    const agentToolNames = normalizeToolConfig(agent.config.tools, {
      agentId: agent.id,
    });

    // Register MCP tools for this agent (connects to relevant servers)
    // This happens before the first message as part of agent setup
    // Errors are handled gracefully - failed MCPs are logged but conversation continues
    const setupResult = yield* registerMCPToolsForAgent(agentToolNames).pipe(
      Effect.either,
    );

    if (setupResult._tag === "Left") {
      // MCP setup had errors, but we continue anyway
      const error = setupResult.left;
      const errorMessage =
        typeof error === "object" && error !== null && "message" in error
          ? String((error as { message: unknown }).message)
          : String(error);
      yield* logger.warn(`Some MCP connections failed during agent setup: ${errorMessage}`);
      yield* terminal.log("");
      yield* terminal.warn(
        "⚠️  Some MCP servers could not be connected. The agent will continue with available tools.",
      );
      yield* terminal.log(
        "   You can still chat with the agent, but tools from failed MCP servers won't be available.",
      );
      yield* terminal.log("");
    } else {
      yield* logger.debug("Agent setup completed - MCP tools registered");
    }
  });
}
