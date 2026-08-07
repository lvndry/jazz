import { describe, expect, it, mock, spyOn } from "bun:test";
import { Effect, Layer } from "effect";
import type { ModelsDevMetadata } from "@/core/utils/models-dev-client";

/**
 * Stub the models.dev catalog so capability checks are deterministic and never
 * touch the network. `catalogEntries` is keyed by model id; a model absent from
 * it stands in for "not in the catalog" (local providers, brand-new releases).
 */
const catalogEntries = new Map<string, ModelsDevMetadata>([
  [
    "claude-haiku-4-5",
    {
      contextWindow: 200_000,
      supportsTools: true,
      isReasoningModel: false,
      supportsVision: true,
      supportsPdf: false,
      supportsTemperature: true,
      inputPricePerMillion: 1,
      outputPricePerMillion: 5,
    },
  ],
  [
    "text-only-model",
    {
      contextWindow: 8_000,
      supportsTools: false,
      isReasoningModel: false,
      supportsVision: false,
      supportsPdf: false,
      supportsTemperature: true,
      inputPricePerMillion: 0.1,
      outputPricePerMillion: 0.2,
    },
  ],
  [
    "gpt-4o",
    {
      contextWindow: 128_000,
      supportsTools: true,
      isReasoningModel: false,
      supportsVision: true,
      supportsPdf: false,
      supportsTemperature: true,
      inputPricePerMillion: 2.5,
      outputPricePerMillion: 10,
    },
  ],
]);

await mock.module("@/core/utils/models-dev-client", () => ({
  getModelsDevMetadata: (modelId: string) => Promise.resolve(catalogEntries.get(modelId)),
  getModelsDevMap: () => Promise.resolve(catalogEntries),
  getMetadataFromMap: (_map: unknown, modelId: string) => catalogEntries.get(modelId),
}));

const { LoggerServiceTag } = await import("@/core/interfaces/logger");
const { PresentationServiceTag } = await import("@/core/interfaces/presentation");
const { LLMServiceTag } = await import("@/core/interfaces/llm");
const { AgentRunner } = await import("../agent-runner");
const { createSubagentTools } = await import("./subagent-tools");

type LoggerService = import("@/core/interfaces/logger").LoggerService;
type PresentationService = import("@/core/interfaces/presentation").PresentationService;
type LLMService = import("@/core/interfaces/llm").LLMService;
type Agent = import("@/core/types").Agent;
type AgentRunnerOptions = import("../types").AgentRunnerOptions;

const mockLogger = {
  debug: () => Effect.void,
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
  setSessionId: () => Effect.void,
  clearSessionId: () => Effect.void,
  writeToFile: () => Effect.void,
  logToolCall: () => Effect.void,
} as unknown as LoggerService;

const mockPresentationService = {
  writeOutput: () => Effect.void,
} as unknown as PresentationService;

const mockLlmService = {
  listProviders: () =>
    Effect.succeed([
      { name: "anthropic", configured: true },
      { name: "openai", configured: true },
      { name: "mistral", configured: false },
    ]),
  getProvider: (name: string) =>
    Effect.succeed({
      name,
      defaultModel: name === "anthropic" ? "claude-haiku-4-5" : "gpt-4o",
      supportedModels:
        name === "anthropic"
          ? [
              { id: "claude-haiku-4-5", supportsTools: true },
              { id: "text-only-model", supportsTools: false },
            ]
          : [{ id: "gpt-4o", supportsTools: true }],
      authenticate: () => Effect.void,
    }),
} as unknown as LLMService;

const testLayer = Layer.mergeAll(
  Layer.succeed(LoggerServiceTag, mockLogger),
  Layer.succeed(PresentationServiceTag, mockPresentationService),
  Layer.succeed(LLMServiceTag, mockLlmService),
);

const parentAgent: Agent = {
  id: "parent-agent",
  name: "Parent",
  description: "",
  model: "test-model",
  config: { persona: "default" } as Agent["config"],
  createdAt: new Date(),
  updatedAt: new Date(),
};

function getSpawnTool() {
  const tool = createSubagentTools().find((t) => t.name === "spawn_subagent");
  if (!tool) throw new Error("spawn_subagent tool not found");
  return tool;
}

describe("spawn_subagent auto-approve inheritance", () => {
  it("forwards the parent's auto-approve policy and allowlists to the sub-agent", async () => {
    let captured: Omit<AgentRunnerOptions, "internal"> | undefined;
    const spy = spyOn(AgentRunner, "runRecursive").mockImplementation((options) => {
      captured = options;
      return Effect.succeed({ content: "done", messages: [] }) as ReturnType<
        typeof AgentRunner.runRecursive
      >;
    });

    try {
      const tool = getSpawnTool();
      const context = {
        agentId: parentAgent.id,
        parentAgent,
        getAutoApprovePolicy: () => true as const,
        autoApprovedCommands: ["git status"],
        autoApprovedTools: ["read_file"],
        onAutoApproveCommand: () => Effect.void,
        onAutoApproveTool: () => {},
      };

      await Effect.runPromise(
        (
          tool.execute({ task: "do a thing", persona: "default" }, context) as Effect.Effect<
            unknown,
            unknown,
            LoggerService | PresentationService
          >
        ).pipe(Effect.provide(testLayer)),
      );

      expect(captured).toBeDefined();
      const forwardedPolicy = captured?.autoApprovePolicy;
      const resolved = typeof forwardedPolicy === "function" ? forwardedPolicy() : forwardedPolicy;
      expect(resolved).toBe(true);
      expect(captured?.autoApprovedCommands).toEqual(["git status"]);
      expect(captured?.autoApprovedTools).toEqual(["read_file"]);
    } finally {
      spy.mockRestore();
    }
  });
});

const codeExplorer: Agent = {
  id: "code-explorer-id",
  name: "code-explorer",
  description: "traces call sites",
  model: "anthropic/claude-sonnet-4-5",
  config: {
    persona: "coder",
    llmProvider: "anthropic",
    llmModel: "claude-sonnet-4-5",
    reasoningEffort: "high",
    whenToUse: "use for tracing call sites across the codebase",
    tools: ["read_file", "grep", "execute_command"],
  } as Agent["config"],
  createdAt: new Date(),
  updatedAt: new Date(),
};

function runSpawn(
  args: Record<string, unknown>,
  context: Record<string, unknown>,
): Promise<{ success: boolean; error?: string }> {
  const tool = getSpawnTool();
  return Effect.runPromise(
    (
      tool.execute(args, { agentId: parentAgent.id, parentAgent, ...context }) as Effect.Effect<
        { success: boolean; error?: string },
        unknown,
        LoggerService | PresentationService | LLMService
      >
    ).pipe(Effect.provide(testLayer)),
  );
}

function captureSpawn(): {
  readonly captured: () => Omit<AgentRunnerOptions, "internal"> | undefined;
  readonly spy: ReturnType<typeof spyOn>;
} {
  let seen: Omit<AgentRunnerOptions, "internal"> | undefined;
  const spy = spyOn(AgentRunner, "runRecursive").mockImplementation((options) => {
    seen = options;
    return Effect.succeed({ content: "done", messages: [] }) as ReturnType<
      typeof AgentRunner.runRecursive
    >;
  });
  return { captured: () => seen, spy };
}

describe("spawn_subagent model override", () => {
  it("runs the child on the chosen model, overriding the named agent's", async () => {
    const { captured, spy } = captureSpawn();

    try {
      const result = await runSpawn(
        { task: "rename a symbol", agent: "code-explorer", model: "anthropic/claude-haiku-4-5" },
        { delegatableAgents: [codeExplorer] },
      );

      expect(result.success).toBe(true);
      expect(captured()?.agent.model).toBe("anthropic/claude-haiku-4-5");
      expect(captured()?.agent.config.llmProvider).toBe("anthropic");
      expect(captured()?.agent.config.llmModel).toBe("claude-haiku-4-5");
      // Everything else still comes from the named agent.
      expect(captured()?.agent.config.persona).toBe("coder");
      expect(captured()?.agent.config.reasoningEffort).toBe("high");
    } finally {
      spy.mockRestore();
    }
  });

  it("overrides the model for a persona sub-agent too", async () => {
    const { captured, spy } = captureSpawn();

    try {
      const result = await runSpawn(
        { task: "summarize one file", persona: "researcher", model: "openai/gpt-4o" },
        {},
      );

      expect(result.success).toBe(true);
      expect(captured()?.agent.config.llmModel).toBe("gpt-4o");
      expect(captured()?.agent.config.persona).toBe("researcher");
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects a model that cannot call tools", async () => {
    const { spy } = captureSpawn();

    try {
      const result = await runSpawn(
        { task: "trace callers", model: "anthropic/text-only-model" },
        {},
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("does not support tool calling");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects a malformed model reference", async () => {
    const { spy } = captureSpawn();

    try {
      const result = await runSpawn({ task: "trace callers", model: "claude-haiku-4-5" }, {});

      expect(result.success).toBe(false);
      expect(result.error).toContain("not a valid model reference");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects a provider with no credentials configured", async () => {
    const { spy } = captureSpawn();

    try {
      const result = await runSpawn({ task: "trace callers", model: "mistral/mistral-large" }, {});

      expect(result.success).toBe(false);
      expect(result.error).toContain("no credentials configured");
      expect(result.error).toContain("anthropic");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("allows a model the catalog has never heard of", async () => {
    const { captured, spy } = captureSpawn();

    try {
      // Local providers and brand-new releases are absent from models.dev;
      // refusing them would make those providers undelegatable.
      const result = await runSpawn(
        { task: "trace callers", model: "openai/some-unlisted-model" },
        {},
      );

      expect(result.success).toBe(true);
      expect(captured()?.agent.config.llmModel).toBe("some-unlisted-model");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("spawn_subagent delegation to a saved agent", () => {
  it("runs the task as the named agent, capped by the parent's effective tools", async () => {
    let captured: Omit<AgentRunnerOptions, "internal"> | undefined;
    const spy = spyOn(AgentRunner, "runRecursive").mockImplementation((options) => {
      captured = options;
      return Effect.succeed({ content: "done", messages: [] }) as ReturnType<
        typeof AgentRunner.runRecursive
      >;
    });

    try {
      const result = await runSpawn(
        { task: "trace callers of resolveEffectiveContextWindow", agent: "code-explorer" },
        {
          delegatableAgents: [codeExplorer],
          parentToolNames: ["read_file", "grep", "spawn_subagent"],
        },
      );

      expect(result.success).toBe(true);
      expect(captured?.agent.model).toBe("anthropic/claude-sonnet-4-5");
      expect(captured?.agent.config.persona).toBe("coder");
      expect(captured?.agent.config.reasoningEffort).toBe("high");
      expect(captured?.agent.name).toBe("code-explorer");
      // The named agent declares execute_command; the parent does not hold it,
      // so the ceiling handed to the child must not include it.
      expect(captured?.toolAllowlist).toEqual(["read_file", "grep", "spawn_subagent"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("matches roster names case-insensitively", async () => {
    let captured: Omit<AgentRunnerOptions, "internal"> | undefined;
    const spy = spyOn(AgentRunner, "runRecursive").mockImplementation((options) => {
      captured = options;
      return Effect.succeed({ content: "done", messages: [] }) as ReturnType<
        typeof AgentRunner.runRecursive
      >;
    });

    try {
      const result = await runSpawn(
        { task: "trace callers", agent: "Code-Explorer" },
        { delegatableAgents: [codeExplorer] },
      );

      expect(result.success).toBe(true);
      expect(captured?.agent.config.llmModel).toBe("claude-sonnet-4-5");
    } finally {
      spy.mockRestore();
    }
  });

  it("fails with the available names when the agent is not in the roster", async () => {
    const spy = spyOn(AgentRunner, "runRecursive").mockImplementation(
      () =>
        Effect.succeed({ content: "done", messages: [] }) as ReturnType<
          typeof AgentRunner.runRecursive
        >,
    );

    try {
      const result = await runSpawn(
        { task: "trace callers", agent: "nonexistent" },
        { delegatableAgents: [codeExplorer] },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("nonexistent");
      expect(result.error).toContain("code-explorer");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects passing both agent and persona", async () => {
    const spy = spyOn(AgentRunner, "runRecursive").mockImplementation(
      () =>
        Effect.succeed({ content: "done", messages: [] }) as ReturnType<
          typeof AgentRunner.runRecursive
        >,
    );

    try {
      const result = await runSpawn(
        { task: "trace callers", agent: "code-explorer", persona: "researcher" },
        { delegatableAgents: [codeExplorer] },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("not both");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps inheriting the parent's config when no agent is named", async () => {
    let captured: Omit<AgentRunnerOptions, "internal"> | undefined;
    const spy = spyOn(AgentRunner, "runRecursive").mockImplementation((options) => {
      captured = options;
      return Effect.succeed({ content: "done", messages: [] }) as ReturnType<
        typeof AgentRunner.runRecursive
      >;
    });

    try {
      await runSpawn(
        { task: "summarize the readme", persona: "researcher" },
        { delegatableAgents: [codeExplorer], parentToolNames: ["read_file"] },
      );

      expect(captured?.agent.model).toBe(parentAgent.model);
      expect(captured?.agent.config.persona).toBe("researcher");
      expect(captured?.toolAllowlist).toEqual(["read_file"]);
    } finally {
      spy.mockRestore();
    }
  });
});

function getListModelsTool() {
  const tool = createSubagentTools().find((candidate) => candidate.name === "list_models");
  if (!tool) throw new Error("list_models tool not found");
  return tool;
}

function runListModels(
  args: Record<string, unknown> = {},
): Promise<{ success: boolean; result: unknown; error?: string }> {
  const tool = getListModelsTool();
  return Effect.runPromise(
    (
      tool.execute(args, { agentId: parentAgent.id }) as Effect.Effect<
        { success: boolean; result: unknown; error?: string },
        unknown,
        LoggerService | PresentationService | LLMService
      >
    ).pipe(Effect.provide(testLayer)),
  );
}

describe("list_models", () => {
  it("lists configured providers' models cheapest first, with prices and capabilities", async () => {
    const result = await runListModels();

    expect(result.success).toBe(true);
    const lines = String(result.result).split("\n");
    const references = lines
      .slice(1)
      .map((line) => line.split(" · ")[0])
      .filter(Boolean);

    // text-only-model ($0.20 out) < claude-haiku-4-5 ($5) < gpt-4o ($10).
    expect(references).toEqual([
      "anthropic/text-only-model",
      "anthropic/claude-haiku-4-5",
      "openai/gpt-4o",
    ]);
    expect(String(result.result)).toContain("in $1.00 / out $5.00 per 1M");
    expect(String(result.result)).toContain("ctx 200k");
    expect(String(result.result)).toContain("tools,vision");
  });

  it("omits unconfigured providers", async () => {
    const result = await runListModels();

    expect(String(result.result)).not.toContain("mistral");
  });

  it("filters to models with a required capability", async () => {
    const result = await runListModels({ requires: ["tools"] });

    expect(result.success).toBe(true);
    expect(String(result.result)).not.toContain("text-only-model");
    expect(String(result.result)).toContain("claude-haiku-4-5");
  });

  it("filters on minimum context window", async () => {
    const result = await runListModels({ minContextWindow: 150_000 });

    expect(String(result.result)).toContain("claude-haiku-4-5");
    expect(String(result.result)).not.toContain("gpt-4o");
  });

  it("reports no match rather than failing when filters exclude everything", async () => {
    const result = await runListModels({ requires: ["pdf"] });

    expect(result.success).toBe(true);
    expect(String(result.result)).toContain("No models");
  });

  it("rejects an unconfigured provider by name", async () => {
    const result = await runListModels({ provider: "mistral" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("not configured");
  });
});
