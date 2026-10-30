import type { ToolDefinition } from "@jazz/core/types/tools";
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { bridgeJazzTools, isBridgedToolName } from "./tool-bridge";

function definition(name: string, parameters: z.ZodTypeAny): ToolDefinition {
  return { type: "function", function: { name, description: `${name} tool`, parameters } };
}

describe("isBridgedToolName", () => {
  test("recognizes tools exposed through the jazz MCP server", () => {
    expect(isBridgedToolName("mcp__jazz__read_file")).toBe(true);
    expect(isBridgedToolName("read_file")).toBe(false);
    expect(isBridgedToolName("mcp__other__read_file")).toBe(false);
  });
});

describe("bridgeJazzTools", () => {
  const toolHost = async () => ({ success: true, result: "ok" });

  test("allows every bridged tool under its namespaced name", () => {
    const bridge = bridgeJazzTools(
      [definition("read_file", z.object({ path: z.string() })), definition("pwd", z.object({}))],
      toolHost,
    );
    expect(bridge.allowedTools).toEqual(["mcp__jazz__read_file", "mcp__jazz__pwd"]);
    expect(Object.keys(bridge.mcpServers)).toEqual(["jazz"]);
  });

  test("accepts a tool whose schema carries a record", () => {
    const bridge = bridgeJazzTools(
      [definition("spawn_subagent", z.object({ resultSchema: z.record(z.string(), z.unknown()) }))],
      toolHost,
    );
    expect(bridge.allowedTools).toEqual(["mcp__jazz__spawn_subagent"]);
  });

  test("accepts a tool that advertises plain JSON Schema", () => {
    const advertised: ToolDefinition = {
      type: "function",
      function: {
        name: "custom",
        description: "custom tool",
        parameters: z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]),
        jsonSchema: { type: "object", properties: { a: { type: "string" } } },
      },
    };
    expect(bridgeJazzTools([advertised], toolHost).allowedTools).toEqual(["mcp__jazz__custom"]);
  });
});
