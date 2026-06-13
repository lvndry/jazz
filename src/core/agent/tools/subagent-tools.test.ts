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
