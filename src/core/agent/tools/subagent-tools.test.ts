import { describe, expect, it, spyOn } from "bun:test";
import { Effect, Layer } from "effect";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import type { LoggerService } from "@/core/interfaces/logger";
import { PresentationServiceTag } from "@/core/interfaces/presentation";
import type { PresentationService } from "@/core/interfaces/presentation";
import type { Agent } from "@/core/types";
import { AgentRunner } from "../agent-runner";
import type { AgentRunnerOptions } from "../types";
import { createSubagentTools } from "./subagent-tools";

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

const testLayer = Layer.mergeAll(
  Layer.succeed(LoggerServiceTag, mockLogger),
  Layer.succeed(PresentationServiceTag, mockPresentationService),
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
    delegatable: true,
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
        LoggerService | PresentationService
      >
    ).pipe(Effect.provide(testLayer)),
  );
}

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
