import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { MCPServerConfig } from "@/core/interfaces/mcp-server";
import type { ToolExecutionContext } from "@/core/types";
import type { MCPTool } from "@/core/types/mcp";
import { registerMCPServerTools } from "./mcp-tools";

const serverConfig = { name: "probe", type: "stdio" } as unknown as MCPServerConfig;

const context: ToolExecutionContext = {
  agentId: "test-agent",
  conversationId: "test-conversation",
};

/**
 * An MCP tool from an untrusted server registers as an approval/execute pair.
 * Both halves share the advertised schema and validator; only the execute half
 * carries the handler that reaches the server, so argument handling has to be
 * probed there.
 */
async function buildTool(inputSchema: unknown) {
  const tools = await Effect.runPromise(
    registerMCPServerTools(serverConfig, [
      { name: "search", description: "probe tool", inputSchema } as unknown as MCPTool,
    ]),
  );
  const approval = tools[0];
  const execute = tools[1];
  if (!approval || !execute) throw new Error("no tool pair registered");
  return { approval, execute };
}

/**
 * The handler needs live MCP services, so a call that clears validation dies on
 * a missing service. A locally rejected call short-circuits to a `success: false`
 * tool result instead — which is what must not happen for arguments the server
 * would have accepted.
 */
async function localValidationError(
  tool: Awaited<ReturnType<typeof buildTool>>,
  args: Record<string, unknown>,
): Promise<string | null> {
  const exit = await Effect.runPromiseExit(
    tool.execute.execute(args, context) as unknown as Effect.Effect<
      { success: boolean; error?: string },
      unknown
    >,
  );
  if (exit._tag === "Failure") return null;
  return exit.value.success === false ? (exit.value.error ?? "rejected") : null;
}

function parseWithAdvertisedSchema(
  tool: Awaited<ReturnType<typeof buildTool>>,
  args: Record<string, unknown>,
) {
  return (
    tool.approval.parameters as unknown as {
      safeParse: (value: unknown) => { success: boolean; data?: unknown };
    }
  ).safeParse(args);
}

/** Schemas a real MCP server can legitimately publish that the Zod conversion handles badly. */
const LOSSY_SCHEMAS: { label: string; schema: unknown }[] = [
  { label: "no input schema at all", schema: undefined },
  { label: "unresolvable $ref", schema: { $ref: "#/$defs/Args" } },
  { label: "properties without a top-level type", schema: { properties: { query: {} } } },
  { label: "explicitly empty properties", schema: { type: "object", properties: {} } },
];

describe("MCP tool argument handling", () => {
  test.each(LOSSY_SCHEMAS)("keeps every argument for a schema with $label", async ({ schema }) => {
    const tool = await buildTool(schema);
    const args = { query: "hello", limit: 5 };

    // The advertised schema must not silently drop keys the model supplied.
    const parsed = parseWithAdvertisedSchema(tool, args);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual(args);

    expect(await localValidationError(tool, args)).toBeNull();
  });

  test("accepts a valid call against a schema with an untyped property", async () => {
    const tool = await buildTool({
      type: "object",
      properties: { query: { description: "free-form" } },
      required: ["query"],
    });
    expect(await localValidationError(tool, { query: "hello" })).toBeNull();
  });

  test("accepts extra keys when the server declares additionalProperties: false", async () => {
    const tool = await buildTool({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    });
    expect(await localValidationError(tool, { query: "hello", extra: 1 })).toBeNull();
  });

  test("forwards arguments the converted schema does not name", async () => {
    const tool = await buildTool({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    });
    expect(await localValidationError(tool, { query: "hello", cursor: "abc" })).toBeNull();
  });
});
