import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import { registerMCPToolsForAgent } from "@/core/agent/tools/register-mcp-tools";
import { normalizeToolConfig } from "@/core/agent/utils/tool-config";
import type { AgentConfigService } from "@/core/interfaces/agent-config";
import { FileSystemContextServiceTag, type FileSystemContextService } from "@/core/interfaces/fs";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import type { MCPServerManager } from "@/core/interfaces/mcp-server";
import { MCPServerManagerTag } from "@/core/interfaces/mcp-server";
import { PresentationServiceTag, type PresentationService } from "@/core/interfaces/presentation";
import type { TerminalService } from "@/core/interfaces/terminal";
import type { ToolRegistry } from "@/core/interfaces/tool-registry";
import type { Agent } from "@/core/types";
import { setMcpPromptCommands } from "@/services/chat/commands";
import { registerElicitationHandler } from "./elicitation";

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
  conversationId: string,
): Effect.Effect<
  void,
  never,
  | ToolRegistry
  | MCPServerManager
  | AgentConfigService
  | FileSystemContextService
  | LoggerService
  | TerminalService
  | PresentationService
> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const presentation = yield* PresentationServiceTag;
    yield* logger.setLogGroup(conversationId);

    // Get agent's tool names
    const agentToolNames = normalizeToolConfig(agent.config.tools, {
      agentId: agent.id,
    });

    // Tell servers which directory this agent works in before they connect, so
    // one that scopes itself to roots starts out pointed at the right place.
    yield* advertiseAgentRoots(agent.id, conversationId);

    // Registered before connecting: a server may elicit during its very first
    // tool call, and there is no later hook that would still be in time.
    yield* registerElicitationHandler();

    // Register MCP tools for this agent (connects to relevant servers)
    // This happens before the first message as part of agent setup
    // Errors are handled gracefully - failed MCPs are logged but conversation continues
    const setupResult = yield* registerMCPToolsForAgent(agentToolNames).pipe(Effect.either);

    if (setupResult._tag === "Left") {
      // MCP setup had errors, but we continue anyway
      const error = setupResult.left;
      const errorMessage =
        typeof error === "object" && error !== null && "message" in error
          ? String((error as { message: unknown }).message)
          : String(error);
      yield* logger.warn(`Some MCP connections failed during agent setup: ${errorMessage}`);
      yield* presentation.presentStatus(
        "Some MCP servers could not be connected. The agent will continue with available tools.",
        "warning",
      );
      yield* presentation.presentStatus(
        "You can still chat with the agent, but tools from failed MCP servers won't be available.",
        "info",
      );
    } else {
      yield* logger.debug("Agent setup completed - MCP tools registered");
      yield* registerMcpPromptCommands(setupResult.right);
    }
  });
}

/**
 * Advertise the agent's working directory as its MCP root.
 *
 * Without this a filesystem-scoped server has to be handed its paths at spawn
 * time, which pins it to whatever directory Jazz happened to launch in.
 */
function advertiseAgentRoots(
  agentId: string,
  conversationId: string,
): Effect.Effect<void, never, MCPServerManager | FileSystemContextService | LoggerService> {
  return Effect.gen(function* () {
    const shell = yield* FileSystemContextServiceTag;
    const mcpManager = yield* MCPServerManagerTag;

    const cwd = yield* shell.getCwd({ agentId, conversationId });
    yield* mcpManager.setRoots([{ uri: pathToFileURL(cwd).href, name: "workspace" }]);
  });
}

/**
 * Publish the connected servers' prompts as `/server:prompt` slash commands.
 *
 * MCP prompts are user-initiated, so a slash command is the right surface —
 * unlike tools, the model never invokes these. Servers that advertise no
 * prompts simply contribute nothing.
 */
function registerMcpPromptCommands(
  connectedServers: readonly string[],
): Effect.Effect<void, never, MCPServerManager | LoggerService> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;

    if (connectedServers.length === 0) {
      setMcpPromptCommands([]);
      return;
    }

    const mcpManager = yield* MCPServerManagerTag;
    const commands: { name: string; description: string; usage?: string }[] = [];

    for (const serverName of connectedServers) {
      const prompts = yield* mcpManager.getServerPrompts(serverName).pipe(Effect.either);
      if (prompts._tag === "Left") {
        yield* logger.debug(
          `Could not list prompts for MCP server ${serverName}: ${prompts.left.reason}`,
        );
        continue;
      }

      for (const prompt of prompts.right) {
        const declared = prompt.arguments ?? [];
        commands.push({
          name: `${serverName}:${prompt.name}`,
          description: prompt.description ?? prompt.title ?? `${serverName} prompt`,
          ...(declared.length > 0
            ? {
                usage: declared
                  .map((argument) =>
                    argument.required === true ? `<${argument.name}>` : `[${argument.name}]`,
                  )
                  .join(" "),
              }
            : {}),
        });
      }
    }

    setMcpPromptCommands(commands);

    if (commands.length > 0) {
      yield* logger.info(
        `Registered ${commands.length} MCP prompt command(s): ${commands.map((command) => `/${command.name}`).join(", ")}`,
      );
    }
  });
}
