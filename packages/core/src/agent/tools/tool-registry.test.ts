import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, mock } from "bun:test";
import { Effect, Layer } from "effect";
import { z } from "zod";
import { misfireLogPath } from "./misfire-log";
import { createToolRegistryLayer } from "./tool-registry";
import { AgentConfigServiceTag, type AgentConfigService } from "../../interfaces/agent-config";
import { LoggerServiceTag, type LoggerService } from "../../interfaces/logger";
import { ToolRegistryTag } from "../../interfaces/tool-registry";
import { type Tool, type ToolRequirements } from "../../interfaces/tool-registry";
import type { ToolExecutionResult } from "../../types/tools";

describe("ToolRegistry", () => {
  const testLayer = createToolRegistryLayer();

  it("should register and retrieve a tool", async () => {
    const mockTool: Tool<ToolRequirements> = {
      name: "test-tool",
      description: "A test tool",
      parameters: z.object({}),
      hidden: false,
      riskLevel: "read-only",
      disclosure: "public",
      egress: false,
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
      riskLevel: "read-only",
      disclosure: "public",
      egress: false,
      execute: () => Effect.succeed({ success: true, result: "" }),
      createSummary: undefined,
    };
    const tool2: Tool<ToolRequirements> = {
      name: "tool2",
      description: "desc",
      parameters: z.object({}),
      hidden: true,
      riskLevel: "read-only",
      disclosure: "public",
      egress: false,
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

  it("should resolve tool aliases to the primary tool", async () => {
    const mockTool: Tool<ToolRequirements> = {
      name: "primary-tool",
      description: "A tool with aliases",
      aliases: ["alias-one", "alias-two"],
      parameters: z.object({}),
      hidden: false,
      riskLevel: "read-only",
      disclosure: "public",
      egress: false,
      execute: mock(() => Effect.succeed({ success: true, result: "ok" })),
      createSummary: undefined,
    };

    const program = Effect.gen(function* () {
      const registry = yield* ToolRegistryTag;
      yield* registry.registerTool(mockTool);
      const byPrimary = yield* registry.getTool("primary-tool");
      const byAlias1 = yield* registry.getTool("alias-one");
      const byAlias2 = yield* registry.getTool("alias-two");
      return { byPrimary, byAlias1, byAlias2 };
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer)));
    expect(result.byPrimary.name).toBe("primary-tool");
    expect(result.byAlias1.name).toBe("primary-tool");
    expect(result.byAlias2.name).toBe("primary-tool");
  });

  it("lists aliases from listAllTools and advertises them in definitions", async () => {
    const mockTool: Tool<ToolRequirements> = {
      name: "find",
      description: "Find files",
      aliases: ["glob"],
      parameters: z.object({}),
      hidden: false,
      riskLevel: "read-only",
      disclosure: "public",
      egress: false,
      execute: mock(() => Effect.succeed({ success: true, result: "ok" })),
      createSummary: undefined,
    };

    const program = Effect.gen(function* () {
      const registry = yield* ToolRegistryTag;
      yield* registry.registerTool(mockTool);
      const allNames = yield* registry.listAllTools();
      const listed = yield* registry.listTools();
      const definitions = yield* registry.getToolDefinitions();
      return { allNames, listed, definitionNames: definitions.map((d) => d.function.name) };
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer)));
    expect(result.allNames).toContain("glob");
    expect(result.listed).not.toContain("glob");
    expect(result.definitionNames).toContain("find");
    expect(result.definitionNames).toContain("glob");
  });

  it("should manage tool categories", async () => {
    const category = { id: "cat1", displayName: "Category 1", loadTier: "eager" as const };
    const tool: Tool<ToolRequirements> = {
      name: "cat-tool",
      description: "desc",
      parameters: z.object({}),
      hidden: false,
      riskLevel: "read-only",
      disclosure: "public",
      egress: false,
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

  describe("load-tier splitting", () => {
    const eagerCategory = { id: "eager-cat", displayName: "Eager", loadTier: "eager" as const };
    const deferredCategory = {
      id: "deferred-cat",
      displayName: "Deferred",
      loadTier: "deferred" as const,
    };

    function makeTool(name: string, summary?: string): Tool<ToolRequirements> {
      return {
        name,
        description: `Full description for ${name}. Extra detail that a summary would drop.`,
        ...(summary !== undefined ? { summary } : {}),
        parameters: z.object({}),
        hidden: false,
        riskLevel: "read-only",
        disclosure: "internal",
        egress: false,
        execute: () => Effect.succeed({ success: true, result: "" }),
        createSummary: undefined,
      };
    }

    it("partitionByTier splits by category loadTier, defaulting uncategorized names to eager", async () => {
      const program = Effect.gen(function* () {
        const registry = yield* ToolRegistryTag;
        yield* registry.registerTool(makeTool("eager-tool"), eagerCategory);
        yield* registry.registerTool(makeTool("deferred-tool"), deferredCategory);
        yield* registry.registerTool(makeTool("uncategorized-tool"));
        return yield* registry.partitionByTier([
          "eager-tool",
          "deferred-tool",
          "uncategorized-tool",
        ]);
      });

      const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer)));
      expect(result.eager).toEqual(["eager-tool", "uncategorized-tool"]);
      expect(result.deferred).toEqual(["deferred-tool"]);
    });

    it("getToolSummaries uses the explicit summary when set, else truncates the description", async () => {
      const longDescription =
        "A".repeat(90) + " and then some more words that push it past the fallback cutoff length";
      const program = Effect.gen(function* () {
        const registry = yield* ToolRegistryTag;
        yield* registry.registerTool(
          makeTool("with-summary", "Short explicit summary."),
          deferredCategory,
        );
        yield* registry.registerTool(
          { ...makeTool("no-summary"), description: longDescription },
          deferredCategory,
        );
        return yield* registry.getToolSummaries(["with-summary", "no-summary"]);
      });

      const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer)));
      const withSummary = result.find((s) => s.name === "with-summary");
      const noSummary = result.find((s) => s.name === "no-summary");

      expect(withSummary?.summary).toBe("Short explicit summary.");
      expect(withSummary?.categoryDisplayName).toBe("Deferred");
      expect(noSummary?.summary.length).toBeLessThanOrEqual(103); // 100 + "..."
      expect(noSummary?.summary.endsWith("...")).toBe(true);
    });

    it("getToolDefinitionsFor returns full schemas only for the requested, non-hidden names", async () => {
      const program = Effect.gen(function* () {
        const registry = yield* ToolRegistryTag;
        yield* registry.registerTool(makeTool("wanted"), deferredCategory);
        yield* registry.registerTool(makeTool("unwanted"), deferredCategory);
        yield* registry.registerTool(
          { ...makeTool("hidden-wanted"), hidden: true },
          deferredCategory,
        );
        return yield* registry.getToolDefinitionsFor(["wanted", "hidden-wanted"]);
      });

      const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer)));
      expect(result.map((d) => d.function.name)).toEqual(["wanted"]);
    });
  });
});

describe("ToolRegistry.executeTool redacts secrets", () => {
  const apiKey = "sk-proj-configured0123456789abcdef";
  const quietLogger = {
    debug: () => Effect.void,
    info: () => Effect.void,
    warn: () => Effect.void,
    error: () => Effect.void,
  } as unknown as LoggerService;
  const config = {
    appConfig: Effect.succeed({ llm: { openai: { api_key: apiKey } } }),
  } as unknown as AgentConfigService;

  function execute(
    output: Effect.Effect<ToolExecutionResult, Error>,
    configService: AgentConfigService = config,
  ) {
    const tool: Tool<ToolRequirements> = {
      name: "reader",
      description: "Reads",
      parameters: z.object({}),
      hidden: false,
      riskLevel: "read-only",
      disclosure: "public",
      egress: false,
      execute: () => output,
      createSummary: undefined,
    };
    const program = Effect.gen(function* () {
      const registry = yield* ToolRegistryTag;
      yield* registry.registerTool(tool);
      return yield* registry.executeTool("reader", {}, { agentId: "agent", conversationId: "c" });
    });
    return Effect.runPromise(
      program.pipe(
        Effect.provide(
          Layer.mergeAll(
            createToolRegistryLayer(),
            Layer.succeed(LoggerServiceTag, quietLogger),
            Layer.succeed(AgentConfigServiceTag, configService),
          ),
        ),
      ) as Effect.Effect<ToolExecutionResult, never, never>,
    );
  }

  it("replaces a configured key and .env assignments in a result", async () => {
    const result = await execute(
      Effect.succeed({
        success: true,
        result: { content: `1|OPENAI_API_KEY=${apiKey}\n2|DB_PASSWORD=hunter2\n3|DEBUG=1` },
      }),
    );
    expect(result.result).toEqual({
      content:
        "1|OPENAI_API_KEY=[redacted:llm.openai.api_key]\n2|DB_PASSWORD=[redacted:DB_PASSWORD]\n3|DEBUG=1",
    });
  });

  it("replaces the secrets the config service holds outside the config", async () => {
    const peerToken = "peer-token-held-in-keyring-0123";
    const withHeld = {
      ...config,
      knownSecrets: Effect.succeed([{ name: "peers.sam.token", value: peerToken }]),
    } as unknown as AgentConfigService;
    const result = await execute(
      Effect.succeed({ success: true, result: { content: `curl -H "X: ${peerToken}"` } }),
      withHeld,
    );
    expect(result.result).toEqual({ content: 'curl -H "X: [redacted:peers.sam.token]"' });
  });

  it("redacts a failure before it is returned or written to the misfire log", async () => {
    const home = mkdtempSync(join(tmpdir(), "jazz-registry-redaction-"));
    const previousHome = process.env["JAZZ_HOME"];
    process.env["JAZZ_HOME"] = home;
    try {
      const result = await execute(Effect.fail(new Error(`request with ${apiKey} failed`)));
      expect(result.error).toBe("request with [redacted:llm.openai.api_key] failed");
      const misfires = readFileSync(misfireLogPath(), "utf8");
      expect(misfires).toContain("[redacted:llm.openai.api_key]");
      expect(misfires).not.toContain(apiKey);
    } finally {
      if (previousHome === undefined) {
        delete process.env["JAZZ_HOME"];
      } else {
        process.env["JAZZ_HOME"] = previousHome;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("redacts an approval preview and keeps the arguments that run once approved", async () => {
    const executeArgs = { path: ".env", content: "NEW_TOKEN=abc" };
    const result = await execute(
      Effect.succeed({
        success: true,
        result: {
          approvalRequired: true,
          message: `Overwrite .env holding ${apiKey}`,
          executeToolName: "execute_write_file",
          executeArgs,
          previewDiff: `-OPENAI_API_KEY=${apiKey}\n+NEW_TOKEN=abc`,
        },
      }),
    );
    expect(result.result).toEqual({
      approvalRequired: true,
      message: "Overwrite .env holding [redacted:llm.openai.api_key]",
      executeToolName: "execute_write_file",
      executeArgs,
      previewDiff: "-OPENAI_API_KEY=[redacted:llm.openai.api_key]\n+NEW_TOKEN=[redacted:NEW_TOKEN]",
    });
  });
});
