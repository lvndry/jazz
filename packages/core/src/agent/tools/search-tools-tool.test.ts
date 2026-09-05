import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { z } from "zod";
import { JOB_TIMEOUT_MINUTES } from "@/core/constants/job-queue";
import { ToolRegistryTag, type Tool, type ToolRequirements } from "@/core/interfaces/tool-registry";
import type { ToolExecutionContext } from "@/core/types/tools";
import { createJobQueueTools } from "./job-queue-tools";
import {
  createSearchToolsTool,
  MAX_SEARCH_TOOLS_RESULTS,
  rankToolsByQuery,
} from "./search-tools-tool";
import { createToolRegistryLayer } from "./tool-registry";
import { createRegisterTriggerTool } from "./wake-trigger-tools";

/** The exact text `search_tools` indexes, read off the shipping tool rather than restated here. */
function enqueueBatchSummary(): string {
  return createJobQueueTools().enqueueBatch.approval.summary ?? "";
}

function registerTriggerSummary(): string {
  return createRegisterTriggerTool().summary ?? "";
}

const deferredCategory = {
  id: "deferred-cat",
  displayName: "Deferred",
  loadTier: "deferred" as const,
};

function makeTool(name: string, summary: string): Tool<ToolRequirements> {
  return {
    name,
    description: `${summary} Full schema hidden until fetched.`,
    summary,
    parameters: z.object({ id: z.string() }),
    hidden: false,
    riskLevel: "read-only",
    disclosure: "internal",
    execute: () => Effect.succeed({ success: true, result: "" }),
    createSummary: undefined,
  };
}

function baseContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return { agentId: "test-agent", ...overrides };
}

describe("rankToolsByQuery", () => {
  it("ranks by token overlap and caps results", () => {
    const candidates = Array.from({ length: MAX_SEARCH_TOOLS_RESULTS + 5 }, (_, i) => ({
      name: `linear_tool_${i}`,
      summary: "Create a Linear issue in a project.",
    }));
    const matches = rankToolsByQuery("create linear issue", candidates);
    expect(matches.length).toBe(MAX_SEARCH_TOOLS_RESULTS);
  });

  it("returns nothing for a query with no overlap", () => {
    const candidates = [{ name: "linear_create_issue", summary: "Create a Linear issue." }];
    expect(rankToolsByQuery("completely unrelated xyz", candidates)).toEqual([]);
  });

  it("returns nothing for an empty query", () => {
    const candidates = [{ name: "linear_create_issue", summary: "Create a Linear issue." }];
    expect(rankToolsByQuery("   ", candidates)).toEqual([]);
  });
});

/**
 * `search_tools` matches literal tokens against name + summary, so a tool is only findable in
 * the words a request would actually use. These queries all returned nothing until the
 * background-job and wake-trigger summaries said "monitor", "watch", "poll" and "log" — leaving
 * an agent asked to watch a CI run with no tool it could find and a `sleep` loop as the fallback.
 */
describe("finding a tool for an open-ended watch", () => {
  const candidates = [
    { name: "enqueue_batch", summary: enqueueBatchSummary() },
    { name: "register_trigger", summary: registerTriggerSummary() },
  ];

  it.each([
    "monitor a github action until it finishes",
    "watch a log file for errors",
    "poll a deploy until it is done",
    "monitor a branch for changes",
    "check back later on a long build",
  ])("resolves %p to a tool that can do it", (query) => {
    expect(rankToolsByQuery(query, candidates).length).toBeGreaterThan(0);
  });

  it("puts the self-rescheduling tool first for a wait that could outlast one job", () => {
    for (const query of [
      "monitor a github action until it finishes",
      "poll a deploy until it is done",
    ]) {
      expect(rankToolsByQuery(query, candidates)[0]).toBe("register_trigger");
    }
  });

  it("still tells the caller the per-job ceiling it has to plan around", () => {
    expect(enqueueBatchSummary()).toContain(`${JOB_TIMEOUT_MINUTES} minutes`);
  });
});

describe("search_tools", () => {
  const testLayer = createToolRegistryLayer();

  it("fetches full schemas for matched deferred tools and calls unlockDeferredTools", async () => {
    const tool = createSearchToolsTool();
    let unlocked: readonly { function: { name: string } }[] = [];

    const program = Effect.gen(function* () {
      const registry = yield* ToolRegistryTag;
      yield* registry.registerTool(
        makeTool("linear_create_issue", "Create a Linear issue in a project."),
        deferredCategory,
      );
      yield* registry.registerTool(
        makeTool("linear_list_issues", "List Linear issues in a project."),
        deferredCategory,
      );

      return yield* tool.execute(
        { query: "create linear issue" },
        baseContext({
          deferredToolNames: ["linear_create_issue", "linear_list_issues"],
          unlockDeferredTools: (defs) => {
            unlocked = defs;
          },
        }),
      );
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer)));
    expect(result.success).toBe(true);
    const matched = (result.result as { matchedToolNames: readonly string[] }).matchedToolNames;
    expect(matched).toContain("linear_create_issue");
    expect(unlocked.map((d) => d.function.name)).toEqual([...matched]);
  });

  it("returns no matches without calling unlockDeferredTools when nothing overlaps", async () => {
    const tool = createSearchToolsTool();
    let unlockCalled = false;

    const program = Effect.gen(function* () {
      const registry = yield* ToolRegistryTag;
      yield* registry.registerTool(
        makeTool("railway_deploy", "Deploy a Railway service."),
        deferredCategory,
      );

      return yield* tool.execute(
        { query: "send a slack message" },
        baseContext({
          deferredToolNames: ["railway_deploy"],
          unlockDeferredTools: () => {
            unlockCalled = true;
          },
        }),
      );
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer)));
    expect(result.success).toBe(true);
    expect((result.result as { matchedToolNames: readonly string[] }).matchedToolNames).toEqual([]);
    expect(unlockCalled).toBe(false);
  });

  it("returns empty immediately when the run has no deferred tools", async () => {
    const tool = createSearchToolsTool();
    const program = tool.execute({ query: "anything" }, baseContext());
    const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer)));
    expect(result.success).toBe(true);
    expect((result.result as { matchedToolNames: readonly string[] }).matchedToolNames).toEqual([]);
  });
});
