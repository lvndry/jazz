import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { ToolRegistryTag, type ToolRegistry } from "@/core/interfaces/tool-registry";
import type { Agent, AgentConfig } from "@/core/types";
import { resolveAgentToolNames, toolDenials } from "./agent-tool-resolution";

function agentWith(config: Partial<AgentConfig>): Agent {
  return {
    id: "agent-1",
    name: "scratch",
    config: {
      persona: "default",
      llmProvider: "anthropic",
      llmModel: "claude-sonnet-4-6",
      ...config,
    },
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
  } as Agent;
}

/**
 * Every built-in category reports the same two tools.
 *
 * They stand for the bundle an agent gets without asking, which is the thing the denials
 * have to be able to reach — narrowing only `config.tools` would never touch them.
 */
const registry = {
  getToolsInCategory: () => Effect.succeed(["read_file", "execute_command"]),
} as unknown as ToolRegistry;

function resolve(agent: Agent): Promise<readonly string[]> {
  // PersonaService is deliberately not provided: `resolveAgentToolNames` reads it through
  // `serviceOption`, so leaving it out is the unrestricted-persona case.
  return Effect.runPromise(
    resolveAgentToolNames(agent).pipe(
      Effect.provideService(ToolRegistryTag, registry),
    ) as Effect.Effect<readonly string[], never, never>,
  );
}

describe("the tools denied to an agent", () => {
  it("is empty when neither scope denies anything", () => {
    expect(toolDenials(agentWith({}), undefined).size).toBe(0);
  });

  it("collects the agent's own denials", () => {
    expect([...toolDenials(agentWith({ deniedTools: ["execute_command"] }), undefined)]).toEqual([
      "execute_command",
    ]);
  });

  it("collects both scopes, since they withhold for different reasons", () => {
    const denied = toolDenials(agentWith({ deniedTools: ["execute_command"] }), {
      deny: ["write_file"],
    });
    expect([...denied].sort()).toEqual(["execute_command", "write_file"]);
  });

  it("counts a tool denied by both scopes once", () => {
    const denied = toolDenials(agentWith({ deniedTools: ["execute_command"] }), {
      deny: ["execute_command"],
    });
    expect(denied.size).toBe(1);
  });
});

describe("resolving what an agent can actually reach", () => {
  it("includes built-in tools the agent never asked for", async () => {
    // The premise everything else depends on: `config.tools` adds to the bundle rather than
    // replacing it, so an empty config is not an agent with no tools.
    expect(await resolve(agentWith({}))).toEqual(["read_file", "execute_command"]);
  });

  it("withholds a built-in tool the agent denies", async () => {
    // The whole point of `deniedTools`: before it, nothing an agent could say about itself
    // could take a bundled tool away.
    expect(await resolve(agentWith({ deniedTools: ["execute_command"] }))).toEqual(["read_file"]);
  });

  it("withholds a tool the agent both asks for and denies", async () => {
    // Contradictory config has to resolve one way. Denial runs last, so it wins — the safe
    // direction, and the one that makes a denial trustworthy.
    const agent = agentWith({ tools: ["mcp_linear"], deniedTools: ["mcp_linear"] });
    expect(await resolve(agent)).not.toContain("mcp_linear");
  });

  it("still grants a requested tool that nothing denies", async () => {
    const agent = agentWith({ tools: ["mcp_linear"], deniedTools: ["execute_command"] });
    expect([...(await resolve(agent))].sort()).toEqual(["mcp_linear", "read_file"]);
  });

  it("ignores a denial naming a tool the agent never had", async () => {
    // A tool can be removed from jazz, or come from an MCP server that is not connected
    // right now. A stale entry should change nothing.
    expect(await resolve(agentWith({ deniedTools: ["mcp_gone"] }))).toEqual([
      "read_file",
      "execute_command",
    ]);
  });
});
