/** Adapting plugin tool declarations into Jazz tools: naming, risk → approval, result mapping. */

import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type { ToolExecutionContext } from "@/core/types";
import type { PluginToolInfo, PluginToolResult } from "@/core/types/plugin";
import { adaptPluginToolToJazz, pluginJazzToolName, type PluginToolInvoker } from "./plugin-tools";

const context = { agentId: "test-agent" } as ToolExecutionContext;

function info(overrides: Partial<PluginToolInfo> = {}): PluginToolInfo {
  return {
    pluginId: "com.example.demo",
    name: "reverse_text",
    description: "Reverse the given text.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    riskLevel: "read-only",
    egress: false,
    ...overrides,
  };
}

const succeeds =
  (result: PluginToolResult): PluginToolInvoker =>
  () =>
    Effect.succeed(result);

describe("adaptPluginToolToJazz", () => {
  it("namespaces the tool name by plugin id", () => {
    expect(pluginJazzToolName("com.example.demo", "reverse_text")).toBe(
      "plugin_com_example_demo_reverse_text",
    );
  });

  it("makes a read-only tool a single tool that advertises the declared JSON schema", () => {
    const tools = adaptPluginToolToJazz(info(), succeeds({ content: "x" }));
    expect(tools).toHaveLength(1);
    const [tool] = tools;
    expect(tool?.name).toBe("plugin_com_example_demo_reverse_text");
    expect(tool?.riskLevel).toBe("read-only");
    expect(tool?.approvalExecuteToolName).toBeUndefined();
    expect(tool?.jsonSchema).toEqual(info().parameters as Readonly<Record<string, unknown>>);
    expect(tool?.egress).toBe(false);
  });

  it("runs the plugin handler and maps a successful result", async () => {
    const tools = adaptPluginToolToJazz(info(), succeeds({ content: "tset" }));
    const result = await Effect.runPromise(
      tools[0]!.execute({ text: "test" }, context) as Effect.Effect<
        { success: boolean; result: unknown; error?: string },
        Error,
        never
      >,
    );
    expect(result).toEqual({ success: true, result: "tset" });
  });

  it("maps an error result to a failed tool execution", async () => {
    const tools = adaptPluginToolToJazz(info(), succeeds({ content: "boom", isError: true }));
    const result = await Effect.runPromise(
      tools[0]!.execute({ text: "test" }, context) as Effect.Effect<
        { success: boolean; result: unknown; error?: string },
        Error,
        never
      >,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("boom");
  });

  it("makes a non-read-only tool an approval pair that gates on execution", async () => {
    const tools = adaptPluginToolToJazz(
      info({ riskLevel: "high-risk", egress: true }),
      succeeds({ content: "done" }),
    );
    expect(tools).toHaveLength(2);
    const [approval, execute] = tools;
    expect(approval?.riskLevel).toBe("high-risk");
    expect(approval?.approvalExecuteToolName).toBe("execute_plugin_com_example_demo_reverse_text");
    expect(execute?.hidden).toBe(true);

    // The visible tool asks for approval rather than running the handler.
    const gated = await Effect.runPromise(
      approval!.execute({ text: "test" }, context) as Effect.Effect<
        { success: boolean; result: unknown; error?: string },
        Error,
        never
      >,
    );
    expect(gated.success).toBe(false);
    expect((gated.result as { approvalRequired?: boolean }).approvalRequired).toBe(true);
  });
});
