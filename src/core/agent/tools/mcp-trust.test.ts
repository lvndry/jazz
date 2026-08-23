import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { MCPServerConfig } from "@/core/interfaces/mcp-server";
import type { MCPTool } from "@/core/types/mcp";
import { registerMCPServerTools, resolveToolRiskLevel } from "./mcp-tools";

function server(trusted: boolean): MCPServerConfig {
  return { name: "probe", command: "noop", trusted } as MCPServerConfig;
}

function tool(name: string, annotations?: MCPTool["annotations"]): MCPTool {
  return { name, description: `${name} tool`, ...(annotations ? { annotations } : {}) };
}

async function build(trusted: boolean, mcpTool: MCPTool) {
  return Effect.runPromise(registerMCPServerTools(server(trusted), [mcpTool]));
}

describe("resolveToolRiskLevel", () => {
  test("treats every tool from an untrusted server as high-risk", () => {
    // The whole point: a server cannot talk its way past the gate by
    // describing itself as harmless.
    expect(resolveToolRiskLevel({ readOnlyHint: true }, false)).toBe("high-risk");
    expect(resolveToolRiskLevel({ destructiveHint: true }, false)).toBe("high-risk");
    expect(resolveToolRiskLevel(undefined, false)).toBe("high-risk");
  });

  test("honours annotations from a trusted server", () => {
    expect(resolveToolRiskLevel({ readOnlyHint: true }, true)).toBe("read-only");
    expect(resolveToolRiskLevel({ destructiveHint: true }, true)).toBe("high-risk");
  });

  test("defaults an unannotated tool from a trusted server to low-risk", () => {
    expect(resolveToolRiskLevel(undefined, true)).toBe("low-risk");
    expect(resolveToolRiskLevel({ idempotentHint: true }, true)).toBe("low-risk");
  });

  test("prefers readOnlyHint when a server sets both", () => {
    expect(resolveToolRiskLevel({ readOnlyHint: true, destructiveHint: true }, true)).toBe(
      "read-only",
    );
  });
});

describe("MCP tool registration", () => {
  test("registers an approval/execute pair for an untrusted server", async () => {
    const tools = await build(false, tool("delete_page", { destructiveHint: true }));

    expect(tools.map((registered) => registered.name)).toEqual([
      "mcp_probe_delete_page",
      "execute_mcp_probe_delete_page",
    ]);
    // The executor gates on this field; without it the tool runs unprompted.
    expect(tools[0]?.approvalExecuteToolName).toBe("execute_mcp_probe_delete_page");
    expect(tools[0]?.riskLevel).toBe("high-risk");
    expect(tools[1]?.hidden).toBe(true);
  });

  test("registers a single ungated tool only when trusted and read-only", async () => {
    const tools = await build(true, tool("list_issues", { readOnlyHint: true }));

    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("mcp_probe_list_issues");
    expect(tools[0]?.approvalExecuteToolName).toBeUndefined();
    expect(tools[0]?.riskLevel).toBe("read-only");
  });

  test("still gates a read-only tool when the server is untrusted", async () => {
    const tools = await build(false, tool("list_issues", { readOnlyHint: true }));

    expect(tools).toHaveLength(2);
    expect(tools[0]?.approvalExecuteToolName).toBe("execute_mcp_probe_list_issues");
  });

  test("gates a trusted server's unannotated tools", async () => {
    const tools = await build(true, tool("send_message"));

    expect(tools).toHaveLength(2);
    expect(tools[0]?.riskLevel).toBe("low-risk");
  });

  test("names the declared annotations in the approval prompt", async () => {
    const tools = await build(false, tool("drop_table", { destructiveHint: true }));
    const approval = tools[0];
    if (!approval) throw new Error("no approval tool");

    const result = (await Effect.runPromise(
      approval.execute(
        { table: "users" },
        {
          agentId: "a",
          conversationId: "c",
        },
      ) as unknown as Effect.Effect<{ result: { message: string } }, never>,
    )) as { result: { message: string } };

    expect(result.result.message).toContain("drop_table");
    expect(result.result.message).toContain("destructive");
    expect(result.result.message).toContain("users");
  });
});
