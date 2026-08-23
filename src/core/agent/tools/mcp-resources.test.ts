import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import type { MCPServerConfig } from "@/core/interfaces/mcp-server";
import { MCPServerManagerTag } from "@/core/interfaces/mcp-server";
import { PresentationServiceTag } from "@/core/interfaces/presentation";
import type { MCPResource } from "@/core/types/mcp";
import { buildResourceTools } from "./mcp-tools";

const serverConfig = { name: "probe", command: "noop" } as MCPServerConfig;

function makeResources(count: number): MCPResource[] {
  return Array.from({ length: count }, (_unused, index) => ({
    uri: `demo://resource/${index}`,
    name: `resource-${index}`,
    description: index % 2 === 0 ? "even numbered" : "odd numbered",
  }));
}

function harness(resources: MCPResource[], text = "body") {
  const manager = Layer.succeed(MCPServerManagerTag, {
    isConnected: () => Effect.succeed(true),
    getServerResources: () => Effect.succeed(resources),
    readResource: () => Effect.succeed([{ uri: "demo://resource/0", text }]),
  } as never);
  const presentation = Layer.succeed(PresentationServiceTag, {
    presentStatus: () => Effect.void,
  } as never);
  const logger = Layer.succeed(LoggerServiceTag, { debug: () => Effect.void } as never);
  return Layer.mergeAll(manager, presentation, logger);
}

async function runList(resources: MCPResource[], args: Record<string, unknown> = {}) {
  const [listTool] = buildResourceTools(serverConfig);
  const result = await Effect.runPromise(
    (
      listTool!.execute(args, { agentId: "a", conversationId: "c" }) as never as Effect.Effect<
        {
          success: boolean;
          result: { resources: MCPResource[]; total: number; matched?: number; truncated?: string };
        },
        never,
        never
      >
    ).pipe(Effect.provide(harness(resources))) as Effect.Effect<
      {
        success: boolean;
        result: { resources: MCPResource[]; total: number; matched?: number; truncated?: string };
      },
      never,
      never
    >,
  );
  return result.result;
}

describe("MCP resource listing", () => {
  test("caps a large catalogue and says so", async () => {
    // A server may advertise thousands of resources; returning all of them
    // would spend the context window on a directory listing.
    const result = await runList(makeResources(500));

    expect(result.resources).toHaveLength(100);
    expect(result.total).toBe(500);
    expect(result.truncated).toContain("filter");
  });

  test("returns a small catalogue whole with no truncation note", async () => {
    const result = await runList(makeResources(7));

    expect(result.resources).toHaveLength(7);
    expect(result.total).toBe(7);
    expect(result.truncated).toBeUndefined();
  });

  test("filters case-insensitively across uri, name, and description", async () => {
    const result = await runList(makeResources(10), { filter: "EVEN" });

    expect(result.matched).toBe(5);
    expect(result.resources.every((resource) => resource.description === "even numbered")).toBe(
      true,
    );
  });

  test("honours a smaller explicit limit", async () => {
    const result = await runList(makeResources(50), { limit: 5 });
    expect(result.resources).toHaveLength(5);
  });

  test("does not let an explicit limit exceed the cap", async () => {
    const result = await runList(makeResources(500), { limit: 10_000 });
    expect(result.resources).toHaveLength(100);
  });
});

describe("MCP resource reads", () => {
  async function runRead(text: string) {
    const [, readTool] = buildResourceTools(serverConfig);
    const result = await Effect.runPromise(
      (
        readTool!.execute(
          { uri: "demo://resource/0" },
          {
            agentId: "a",
            conversationId: "c",
          },
        ) as never as Effect.Effect<{ success: boolean; result: string }, never, never>
      ).pipe(Effect.provide(harness([], text))) as Effect.Effect<
        { success: boolean; result: string },
        never,
        never
      >,
    );
    return result;
  }

  test("returns a small resource intact", async () => {
    const result = await runRead("hello");
    expect(result.result).toBe("hello");
  });

  test("truncates an oversized resource with a visible marker", async () => {
    const result = await runRead("x".repeat(250_000));

    expect(result.result.length).toBeLessThan(120_000);
    expect(result.result).toContain("truncated");
    expect(result.result).toContain("250000 characters");
  });

  // The declared schema rejects this before the handler runs, which is why the
  // handler's own empty-uri guard only ever sees an explicit blank string.
  test("rejects a call with no uri", async () => {
    const [, readTool] = buildResourceTools(serverConfig);
    const result = await Effect.runPromise(
      (
        readTool!.execute({}, { agentId: "a", conversationId: "c" }) as never as Effect.Effect<
          { success: boolean; error: string },
          never,
          never
        >
      ).pipe(Effect.provide(harness([]))) as Effect.Effect<
        { success: boolean; error: string },
        never,
        never
      >,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("uri");
  });
});
