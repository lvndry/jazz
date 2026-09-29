/**
 * Exercises claimed workflow execution across scheduling, approval policy and answer outcomes.
 * Each test owns a private Jazz home and restores the runner spy; durable history must describe
 * the claimed record's actual result without granting an unattended run extra authority.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Effect, Layer } from "effect";
import { AgentRunner } from "@/core/agent/agent-runner";
import type { AgentResponse, AgentRunnerOptions } from "@/core/agent/types";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
import { AgentServiceTag, type AgentService } from "@/core/interfaces/agent-service";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import type { Agent } from "@/core/types/agent";
import { runClaimedWorkflow } from "./catch-up";
import { addRunRecord, loadRunHistory } from "./run-history";
import {
  WorkflowServiceTag,
  type WorkflowMetadata,
  type WorkflowService,
} from "./workflow-service";

const agent: Agent = {
  id: "test-agent",
  name: "test-agent",
  config: { persona: "default", llm: { provider: "openai", model: "gpt-4o-mini" } },
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const baseWorkflow: WorkflowMetadata = {
  name: "recap",
  description: "Recap",
  path: "/test",
};

const logger = {
  debug: () => Effect.void,
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
} as unknown as LoggerService;

describe("claimed workflow execution", () => {
  let previousHome: string | undefined;
  let home: string;
  let runner: ReturnType<typeof spyOn<typeof AgentRunner, "run">>;
  let calls: AgentRunnerOptions[];
  let response: AgentResponse;

  beforeEach(() => {
    previousHome = process.env["JAZZ_HOME"];
    home = mkdtempSync(join(tmpdir(), "jazz-catch-up-execution-"));
    process.env["JAZZ_HOME"] = home;
    calls = [];
    response = { content: "Recap ready", conversationId: "test", messages: [] };
    runner = spyOn(AgentRunner, "run").mockImplementation((options) => {
      calls.push(options);
      return Effect.succeed(response);
    });
  });

  afterEach(() => {
    runner.mockRestore();
    if (previousHome === undefined) delete process.env["JAZZ_HOME"];
    else process.env["JAZZ_HOME"] = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  /** The runner spy has no service requirements; the layer supplies the workflow services. */
  async function execute(workflow: WorkflowMetadata = baseWorkflow) {
    const record = await Effect.runPromise(
      addRunRecord({
        workflowName: workflow.name,
        scheduleLabel: "weekly",
        startedAt: new Date().toISOString(),
        status: "running",
        triggeredBy: "scheduled",
      }),
    );
    const services = Layer.mergeAll(
      Layer.succeed(LoggerServiceTag, logger),
      Layer.succeed(AgentConfigServiceTag, {
        appConfig: Effect.succeed({}),
      } as unknown as AgentConfigService),
      Layer.succeed(AgentServiceTag, {
        getAgent: () => Effect.succeed(agent),
        listAgents: () => Effect.succeed([agent]),
      } as unknown as AgentService),
      Layer.succeed(WorkflowServiceTag, {
        loadWorkflow: () => Effect.succeed({ metadata: workflow, prompt: "Write a recap." }),
      } as unknown as WorkflowService),
    );
    const execution = runClaimedWorkflow({
      workflow,
      record,
      history: [],
      entry: {
        workflowName: workflow.name,
        label: "weekly",
        schedule: "0 6 * * 1",
        enabled: true,
        agent: agent.id,
      },
    }).pipe(Effect.provide(services)) as unknown as Effect.Effect<void>;
    await Effect.runPromise(execution);
    return (await Effect.runPromise(loadRunHistory())).find((entry) => entry.id === record.id);
  }

  it("keeps missing approval policy closed and forwards the workflow origin", async () => {
    const record = await execute();
    expect(calls[0]?.autoApprovePolicy).toBe(false);
    expect(calls[0]?.origin).toEqual({ source: "workflow", name: "recap" });
    expect(record?.status).toBe("completed");
  });

  it("honors an explicitly configured approval tier", async () => {
    await execute({ ...baseWorkflow, autoApprove: "read-only" });
    expect(calls[0]?.autoApprovePolicy).toBe("read-only");
  });

  it("finishes an invalid definition's claimed record without starting the agent", async () => {
    const record = await execute({ ...baseWorkflow, definitionError: "Invalid autoApprove" });
    expect(calls).toHaveLength(0);
    expect(record?.status).toBe("failed");
    expect(record?.error).toContain("Invalid autoApprove");
    expect(record?.owner).toBeUndefined();
  });

  it("records an unusable answer as failed instead of completed", async () => {
    response = { ...response, content: "", emptyCompletion: true, finishReason: "stop" };
    const record = await execute();
    expect(record?.status).toBe("failed");
    expect(record?.error).toContain("empty");
    expect(record?.owner).toBeUndefined();
  });
});
