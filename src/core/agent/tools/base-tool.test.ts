import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { z } from "zod";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";
import { defineApprovalTool, defineTool, makeZodValidator } from "./base-tool";

const context: ToolExecutionContext = {
  agentId: "test-agent",
  conversationId: "test-conversation",
};

const echoParameters = z
  .object({
    path: z.string().min(1),
  })
  .strict();

type EchoArgs = z.infer<typeof echoParameters>;

async function execute(
  tool: {
    execute: (
      args: Record<string, unknown>,
      context: ToolExecutionContext,
    ) => Effect.Effect<ToolExecutionResult, Error>;
  },
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  return Effect.runPromise(tool.execute(args, context));
}

describe("defineTool", () => {
  test("validates arguments and runs the handler", async () => {
    const tool = defineTool({
      name: "echo_path",
      description: "Echo a path",
      disclosure: "public",
      parameters: echoParameters,
      validate: makeZodValidator(echoParameters),
      handler: (args: EchoArgs) => Effect.succeed({ success: true, result: { path: args.path } }),
    });

    const result = await execute(tool, { path: "notes.md" });
    expect(result.success).toBe(true);
    expect(result.result).toEqual({ path: "notes.md" });
  });

  test("returns a field-path error without throwing", async () => {
    const tool = defineTool({
      name: "echo_path",
      description: "Echo a path",
      disclosure: "public",
      parameters: echoParameters,
      handler: (args: EchoArgs) => Effect.succeed({ success: true, result: { path: args.path } }),
    });

    const result = await execute(tool, {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("path:");
  });

  test("defaults to read-only risk", () => {
    const tool = defineTool({
      name: "echo_path",
      description: "Echo a path",
      disclosure: "public",
      parameters: echoParameters,
      handler: () => Effect.succeed({ success: true, result: null }),
    });
    expect(tool.riskLevel).toBe("read-only");
  });
});

describe("defineApprovalTool", () => {
  test("returns an approval payload and a hidden execute counterpart", async () => {
    const pair = defineApprovalTool({
      name: "write_note",
      description: "Write a note",
      disclosure: "public",
      parameters: echoParameters,
      approvalMessage: (args: EchoArgs) => Effect.succeed(`Write ${args.path}`),
      handler: (args: EchoArgs) => Effect.succeed({ success: true, result: { path: args.path } }),
    });

    expect(pair.execute.hidden).toBe(true);
    expect(pair.execute.name).toBe("execute_write_note");
    expect(pair.approval.riskLevel).toBe("high-risk");

    const approval = await execute(pair.approval, { path: "notes.md" });
    expect(approval.success).toBe(false);
    expect(approval.result).toEqual({
      approvalRequired: true,
      message: "Write notes.md",
      previewDiff: undefined,
      executeToolName: "execute_write_note",
      executeArgs: { path: "notes.md" },
    });
  });

  test("skipApproval returns the tool result directly", async () => {
    const pair = defineApprovalTool({
      name: "write_note",
      description: "Write a note",
      disclosure: "public",
      parameters: echoParameters,
      approvalMessage: () =>
        Effect.succeed({
          skipApproval: true as const,
          toolResult: { success: false, result: null, error: "pattern not found" },
        }),
      handler: () => Effect.succeed({ success: true, result: null }),
    });

    const result = await execute(pair.approval, { path: "notes.md" });
    expect(result).toEqual({ success: false, result: null, error: "pattern not found" });
  });
});
