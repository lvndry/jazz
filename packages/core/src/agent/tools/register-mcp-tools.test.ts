import { describe, expect, it, mock } from "bun:test";
import { Effect, Layer } from "effect";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import { MCPServerManagerTag, type MCPServerManager } from "@/core/interfaces/mcp-server";
import { PresentationServiceTag, type PresentationService } from "@/core/interfaces/presentation";
import { TerminalServiceTag, type TerminalService } from "@/core/interfaces/terminal";
import { ToolRegistryTag, type ToolRegistry } from "@/core/interfaces/tool-registry";
import { registerMCPToolsForAgent } from "./register-mcp-tools";

/**
 * `serversToConnect` is intentionally kept empty in every case here (no configured server has
 * `enabled !== false` and a matching name) so the function returns before reaching the actual
 * connect/registration loop — these tests are about the resolution warning, not connecting.
 */
function harness(configuredServers: readonly { name: string; enabled?: boolean }[]) {
  const warn = mock((_message: string, _meta?: Record<string, unknown>) => Effect.void);
  const debug = mock((_message: string, _meta?: Record<string, unknown>) => Effect.void);

  const loggerLayer = Layer.succeed(LoggerServiceTag, {
    debug,
    info: mock(() => Effect.void),
    warn,
    error: mock(() => Effect.void),
  } as unknown as LoggerService);

  const mcpManagerLayer = Layer.succeed(MCPServerManagerTag, {
    listServers: () => Effect.succeed(configuredServers),
  } as unknown as MCPServerManager);

  const layer = Layer.mergeAll(
    loggerLayer,
    mcpManagerLayer,
    Layer.succeed(ToolRegistryTag, {} as unknown as ToolRegistry),
    Layer.succeed(AgentConfigServiceTag, {} as unknown as AgentConfigService),
    Layer.succeed(TerminalServiceTag, {} as unknown as TerminalService),
    Layer.succeed(PresentationServiceTag, {} as unknown as PresentationService),
  );

  return { layer, warn, debug };
}

describe("registerMCPToolsForAgent — server resolution warning", () => {
  it("warns when a tool references a server with no matching configuration", async () => {
    const { layer, warn } = harness([{ name: "notion" }]);

    await Effect.runPromise(
      registerMCPToolsForAgent(["mcp_linear_create_issue"]).pipe(Effect.provide(layer)),
    );

    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]![0];
    expect(message).toContain("mcp_linear_create_issue");
    expect(message).toContain(".agents/mcp.json");
  });

  it("does not warn when every referenced tool matches a configured server", async () => {
    const { layer, warn } = harness([{ name: "notion", enabled: false }]);

    await Effect.runPromise(
      registerMCPToolsForAgent(["mcp_notion_search"]).pipe(Effect.provide(layer)),
    );

    expect(warn).not.toHaveBeenCalled();
  });

  it("does not warn (and skips server lookup entirely) when the agent has no MCP tools", async () => {
    const { layer, warn, debug } = harness([]);

    await Effect.runPromise(registerMCPToolsForAgent(["read_file"]).pipe(Effect.provide(layer)));

    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith("Agent has no MCP tools, skipping MCP server connections");
  });

  it("only names the unresolved tool when a mix of resolved and unresolved names are present", async () => {
    const { layer, warn } = harness([{ name: "notion", enabled: false }]);

    await Effect.runPromise(
      registerMCPToolsForAgent(["mcp_notion_search", "mcp_linear_create_issue"]).pipe(
        Effect.provide(layer),
      ),
    );

    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]![0];
    expect(message).toContain("mcp_linear_create_issue");
    expect(message).not.toContain("mcp_notion_search");
  });
});
