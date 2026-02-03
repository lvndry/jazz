import { describe, expect, it, mock } from "bun:test";
import { Effect } from "effect";
import { z } from "zod";
import { createToolRegistryLayer } from "./tool-registry";
import { ToolRegistryTag } from "../../interfaces/tool-registry";
import { type Tool, type ToolRequirements } from "../../interfaces/tool-registry";

describe("ToolRegistry", () => {
  const testLayer = createToolRegistryLayer();

  it("should register and retrieve a tool", async () => {
    const mockTool: Tool<ToolRequirements> = {
      name: "test-tool",
      description: "A test tool",
      parameters: z.object({}),
      hidden: false,
      execute: mock(() => Effect.succeed({ success: true, result: "ok" })),
      createSummary: undefined,
    };

    const program = Effect.gen(function* () {
      const registry = yield* ToolRegistryTag;
      yield* registry.registerTool(mockTool);
      const tool = yield* registry.getTool("test-tool");
      return tool;
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer)));
    expect(result.name).toBe("test-tool");
  });

  it("should fail to get a non-existent tool", async () => {
    const program = Effect.gen(function* () {
      const registry = yield* ToolRegistryTag;
      return yield* registry.getTool("missing");
    });

    const result = await Effect.runPromiseExit(program.pipe(Effect.provide(testLayer)));
    expect(result._tag).toBe("Failure");
  });

  it("should list tools and filter hidden ones", async () => {
    const tool1: Tool<ToolRequirements> = {
      name: "tool1",
      description: "desc",
      parameters: z.object({}),
      hidden: false,
      execute: () => Effect.succeed({ success: true, result: "" }),
      createSummary: undefined,
    };
    const tool2: Tool<ToolRequirements> = {
      name: "tool2",
      description: "desc",
      parameters: z.object({}),
      hidden: true,
      execute: () => Effect.succeed({ success: true, result: "" }),
      createSummary: undefined,
    };

    const program = Effect.gen(function* () {
      const registry = yield* ToolRegistryTag;
      yield* registry.registerTool(tool1);
      yield* registry.registerTool(tool2);
      return yield* registry.listTools();
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer)));
    expect(result).toContain("tool1");
    expect(result).not.toContain("tool2");
  });

  it("should manage tool categories", async () => {
    const category = { id: "cat1", displayName: "Category 1" };
    const tool: Tool<ToolRequirements> = {
      name: "cat-tool",
      description: "desc",
      parameters: z.object({}),
      hidden: false,
      execute: () => Effect.succeed({ success: true, result: "" }),
      createSummary: undefined,
    };

    const program = Effect.gen(function* () {
      const registry = yield* ToolRegistryTag;
      yield* registry.registerTool(tool, category);
      const byCat = yield* registry.listToolsByCategory();
      const cats = yield* registry.listCategories();
      return { byCat, cats };
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer)));
    expect(result.byCat["Category 1"]).toContain("cat-tool");
    expect(result.cats[0]?.id).toBe("cat1");
  });
});
