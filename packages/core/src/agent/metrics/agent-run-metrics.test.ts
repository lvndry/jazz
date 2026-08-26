import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type { LoggerService } from "@/core/interfaces/logger";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import {
  beginIteration,
  completeIteration,
  createAgentRunMetrics,
  estimateTokens,
  finalizeAgentRun,
  recordClassifierUsage,
  recordLLMUsage,
  recordToolDefinitionTokens,
} from "./agent-run-metrics";

const MINIMAL_AGENT = {
  id: "test-agent-id",
  name: "test-agent",
  config: { persona: "default", llmProvider: "openai" as const, llmModel: "gpt-4" },
  model: "openai/gpt-4" as const,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function createMetrics() {
  return createAgentRunMetrics({
    agent: MINIMAL_AGENT,
    conversationId: "conv-123",
  });
}

describe("estimateTokens", () => {
  it("returns 0 for 0 characters", () => {
    expect(estimateTokens(0)).toBe(0);
  });

  it("returns 1 for 1-4 characters (1 token ≈ 4 chars)", () => {
    expect(estimateTokens(1)).toBe(1);
    expect(estimateTokens(2)).toBe(1);
    expect(estimateTokens(3)).toBe(1);
    expect(estimateTokens(4)).toBe(1);
  });

  it("returns 2 for 5-8 characters", () => {
    expect(estimateTokens(5)).toBe(2);
    expect(estimateTokens(8)).toBe(2);
  });

  it("rounds up for partial tokens", () => {
    expect(estimateTokens(9)).toBe(3);
    expect(estimateTokens(10)).toBe(3);
    expect(estimateTokens(17)).toBe(5);
  });

  it("handles larger character counts consistently", () => {
    expect(estimateTokens(100)).toBe(25);
    expect(estimateTokens(1000)).toBe(250);
    expect(estimateTokens(4000)).toBe(1000);
  });
});

describe("recordToolDefinitionTokens", () => {
  it("increments totalToolDefinitionTokens by tokenEstimate", () => {
    const metrics = createMetrics();
    expect(metrics.totalToolDefinitionTokens).toBe(0);

    recordToolDefinitionTokens(metrics, 50, 3);
    expect(metrics.totalToolDefinitionTokens).toBe(50);

    recordToolDefinitionTokens(metrics, 120, 5);
    expect(metrics.totalToolDefinitionTokens).toBe(170);
  });

  it("increments toolDefinitionsOffered by toolCount", () => {
    const metrics = createMetrics();
    expect(metrics.toolDefinitionsOffered).toBe(0);

    recordToolDefinitionTokens(metrics, 50, 3);
    expect(metrics.toolDefinitionsOffered).toBe(3);

    recordToolDefinitionTokens(metrics, 120, 5);
    expect(metrics.toolDefinitionsOffered).toBe(8);
  });

  it("sets currentIteration.toolDefinitionTokens when iteration is active", () => {
    const metrics = createMetrics();
    beginIteration(metrics, 1);
    expect(metrics.currentIteration).toBeDefined();

    recordToolDefinitionTokens(metrics, 100, 4);
    expect(metrics.currentIteration!.toolDefinitionTokens).toBe(100);

    // Second call within same iteration replaces (not accumulates)
    recordToolDefinitionTokens(metrics, 80, 2);
    expect(metrics.currentIteration!.toolDefinitionTokens).toBe(80);
  });

  it("does not touch currentIteration when no iteration is active", () => {
    const metrics = createMetrics();
    expect(metrics.currentIteration).toBeUndefined();

    recordToolDefinitionTokens(metrics, 50, 2);
    expect(metrics.totalToolDefinitionTokens).toBe(50);
    expect(metrics.toolDefinitionsOffered).toBe(2);
    expect(metrics.currentIteration).toBeUndefined();
  });

  it("records per-iteration values correctly across multiple iterations", () => {
    const metrics = createMetrics();

    beginIteration(metrics, 1);
    recordToolDefinitionTokens(metrics, 100, 3);
    expect(metrics.iterationSummaries[0]!.toolDefinitionTokens).toBe(100);
    completeIteration(metrics);

    beginIteration(metrics, 2);
    recordToolDefinitionTokens(metrics, 60, 2);
    expect(metrics.iterationSummaries[1]!.toolDefinitionTokens).toBe(60);
    completeIteration(metrics);

    expect(metrics.totalToolDefinitionTokens).toBe(160);
    expect(metrics.toolDefinitionsOffered).toBe(5);
  });
});

describe("classifier usage", () => {
  it("keeps classifier tokens out of the agent-loop totals", () => {
    const metrics = createMetrics();
    recordLLMUsage(metrics, { promptTokens: 1000, completionTokens: 200 });
    recordClassifierUsage(metrics, { promptTokens: 80, completionTokens: 2 }, 45);

    expect(metrics.totalPromptTokens).toBe(1000);
    expect(metrics.totalCompletionTokens).toBe(200);
    expect(metrics.classifierPromptTokens).toBe(80);
    expect(metrics.classifierCompletionTokens).toBe(2);
    expect(metrics.classifierRequests).toBe(1);
    expect(metrics.classifierDurationMs).toBe(45);
  });

  it("logs classifier usage beside agent-loop tokens on finalize", async () => {
    const metrics = createMetrics();
    recordLLMUsage(metrics, { promptTokens: 1000, completionTokens: 50 });
    recordClassifierUsage(metrics, { promptTokens: 40, completionTokens: 1 }, 12);
    recordClassifierUsage(metrics, { promptTokens: 42, completionTokens: 1 }, 9);

    let logged: Record<string, unknown> | undefined;
    const logger = {
      debug: () => Effect.void,
      info: (_message: string, meta?: Record<string, unknown>) =>
        Effect.sync(() => {
          logged = meta;
        }),
      warn: () => Effect.void,
      error: () => Effect.void,
    } as unknown as LoggerService;

    await Effect.runPromise(
      finalizeAgentRun(metrics, { iterationsUsed: 1, finished: true }).pipe(
        Effect.provideService(LoggerServiceTag, logger),
      ),
    );

    expect(logged?.["promptTokens"]).toBe(1000);
    expect(logged?.["completionTokens"]).toBe(50);
    expect(logged?.["classifierPromptTokens"]).toBe(82);
    expect(logged?.["classifierCompletionTokens"]).toBe(2);
    expect(logged?.["classifierRequests"]).toBe(2);
    expect(logged?.["classifierDurationMs"]).toBe(21);
  });
});
