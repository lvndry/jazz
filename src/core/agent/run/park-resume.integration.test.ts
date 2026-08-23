/**
 * End-to-end cover for parking and resuming, through the real runner and the real tool
 * executor. Everything outside jazz is faked — the model and the tool's side effect — but
 * the agent loop, the approval path, the park signal and the store are the shipping ones.
 *
 * This exists because the unit suite was entirely green while resume was broken: it handed
 * the model a transcript ending in a tool call with no result, which only a run through the
 * loop can catch.
 */

import os from "node:os";
import { FileSystem } from "@effect/platform";
import { describe, expect, it, mock } from "bun:test";
import { Effect, Layer, Stream } from "effect";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
import { AgentServiceTag, type AgentService } from "@/core/interfaces/agent-service";
import { FileSystemContextServiceTag, type FileSystemContextService } from "@/core/interfaces/fs";
import { LLMServiceTag, type LLMService } from "@/core/interfaces/llm";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import { MCPServerManagerTag, type MCPServerManager } from "@/core/interfaces/mcp-server";
import { PersonaServiceTag, type PersonaService } from "@/core/interfaces/persona-service";
import { PresentationServiceTag, type PresentationService } from "@/core/interfaces/presentation";
import { RunStoreTag } from "@/core/interfaces/run-store";
import { TerminalServiceTag, type TerminalService } from "@/core/interfaces/terminal";
import { ToolRegistryTag, type ToolRegistry } from "@/core/interfaces/tool-registry";
import { SkillServiceTag, type SkillService } from "@/core/skills/skill-service";
import type { Agent } from "@/core/types/agent";
import type { ChatCompletionResponse } from "@/core/types/chat";
import { InMemoryRunStore } from "@/services/storage/run-store";
import { AgentRunner } from "../agent-runner";
import { isRunParkRequested } from "./park-signal";
import { resumeRun } from "./resume";

const AGENT: Agent = {
  id: "parker",
  name: "parker",
  model: "openai/gpt-4",
  config: {
    persona: "default",
    llmProvider: "openai",
    llmModel: "gpt-4",
    tools: ["danger"],
  },
  createdAt: new Date("2026-08-01T00:00:00Z"),
  updatedAt: new Date("2026-08-01T00:00:00Z"),
};

const TOOL_CALL = {
  id: "call_park_1",
  type: "function" as const,
  function: { name: "danger", arguments: JSON.stringify({ target: "/tmp/x" }) },
};

/** Set by the execute tool, so the test can prove the side effect happened exactly once. */
let executions: string[] = [];

function makeLayers(store: InMemoryRunStore) {
  // First completion asks for the gated tool; every later one answers in text. A resumed
  // run must therefore reach the *second* response, which it can only do once the parked
  // tool call has a result.
  let completions = 0;
  const completion = (): ChatCompletionResponse => {
    completions += 1;
    return completions === 1
      ? { id: "c1", model: "gpt-4", content: "", toolCalls: [TOOL_CALL] }
      : { id: "c2", model: "gpt-4", content: "Done." };
  };

  const logger = {
    debug: mock(() => Effect.void),
    info: mock(() => Effect.void),
    warn: mock(() => Effect.void),
    error: mock(() => Effect.void),
    setSessionId: mock(() => Effect.void),
    clearSessionId: mock(() => Effect.void),
    writeToFile: mock(() => Effect.void),
    logToolCall: mock(() => Effect.void),
  } as unknown as LoggerService;

  const presentation = {
    presentThinking: mock(() => Effect.void),
    presentThinkingEnd: mock(() => Effect.void),
    renderMarkdown: mock((content: string) => Effect.succeed(content)),
    presentAgentResponse: mock(() => Effect.void),
    presentCompletion: mock(() => Effect.void),
    writeOutput: mock(() => Effect.void),
    writeBlankLine: mock(() => Effect.void),
    formatToolExecutionStart: mock(() => Effect.succeed("")),
    formatToolExecutionComplete: mock(() => Effect.succeed("")),
    formatToolResult: mock(() => ""),
    formatToolExecutionError: mock(() => Effect.succeed("")),
    formatToolsDetected: mock(() => Effect.succeed("")),
    signalToolExecutionStarted: mock(() => Effect.void),
    // The whole point: nobody is here to answer.
    canPromptForApproval: () => false,
    requestApproval: mock(() => Effect.succeed({ approved: false as const })),
  } as unknown as PresentationService;

  const dangerTool = {
    name: "danger",
    description: "Does something gated",
    riskLevel: "high-risk" as const,
    approvalExecuteToolName: "danger_execute",
    hidden: false,
    longRunning: false,
  };

  const registry = {
    registerTool: mock(() => Effect.succeed(undefined)),
    registerForCategory: mock(() => mock(() => Effect.succeed(undefined))),
    listTools: mock(() => Effect.succeed(["danger"])),
    listAllTools: mock(() => Effect.succeed(["danger", "danger_execute"])),
    getToolsInCategory: mock(() => Effect.succeed([])),
    getTool: mock((name: string) =>
      Effect.succeed(
        name === "danger"
          ? dangerTool
          : { ...dangerTool, name, approvalExecuteToolName: undefined },
      ),
    ),
    getToolDefinitions: mock(() =>
      Effect.succeed([
        { function: { name: "danger", description: "Does something gated", parameters: {} } },
      ]),
    ),
    executeTool: mock((name: string, args: Record<string, unknown>) => {
      if (name === "danger") {
        return Effect.succeed({
          success: true,
          result: {
            approvalRequired: true,
            message: "About to do something gated",
            executeToolName: "danger_execute",
            executeArgs: args,
          },
        });
      }
      executions.push(name);
      return Effect.succeed({ success: true, result: "did the gated thing" });
    }),
  } as unknown as ToolRegistry;

  const llm = {
    getProvider: mock(() =>
      Effect.succeed({
        name: "openai",
        supportedModels: [{ id: "gpt-4", supportsTools: true }],
        defaultModel: "gpt-4",
        authenticate: () => Effect.void,
      }),
    ),
    listProviders: mock(() => Effect.succeed([])),
    createChatCompletion: mock(() => Effect.succeed(completion())),
    createStreamingChatCompletion: mock(() =>
      Effect.succeed({
        stream: Stream.empty,
        response: Effect.succeed(completion()),
        cancel: Effect.void,
      }),
    ),
  } as unknown as LLMService;

  const agentService = {
    getAgent: mock(() => Effect.succeed(AGENT)),
    listAgents: mock(() => Effect.succeed([AGENT])),
  } as unknown as AgentService;

  return Layer.mergeAll(
    Layer.succeed(LoggerServiceTag, logger),
    Layer.succeed(PresentationServiceTag, presentation),
    Layer.succeed(ToolRegistryTag, registry),
    Layer.succeed(LLMServiceTag, llm),
    Layer.succeed(AgentServiceTag, agentService),
    Layer.succeed(RunStoreTag, store),
    Layer.succeed(SkillServiceTag, {
      listSkills: mock(() => Effect.succeed([])),
    } as unknown as SkillService),
    Layer.succeed(AgentConfigServiceTag, {
      appConfig: Effect.succeed({
        output: { showMetrics: false, streaming: { enabled: false }, mode: "text" as const },
        llm: { openai: { api_key: "test-key" } },
      }),
      get: mock(() => Effect.succeed(undefined)),
      getOrElse: mock((_key: string, fallback: unknown) => Effect.succeed(fallback)),
      getOrFail: mock(() => Effect.succeed(undefined)),
      has: mock(() => Effect.succeed(false)),
      set: mock(() => Effect.void),
    } as unknown as AgentConfigService),
    Layer.succeed(PersonaServiceTag, {
      getPersonaByIdentifier: mock(() =>
        Effect.succeed({
          name: "default",
          description: "test persona",
          systemPrompt: "You are a test agent.",
        }),
      ),
    } as unknown as PersonaService),
    Layer.succeed(MCPServerManagerTag, {} as unknown as MCPServerManager),
    Layer.succeed(TerminalServiceTag, {} as unknown as TerminalService),
    Layer.succeed(FileSystem.FileSystem, {} as unknown as FileSystem.FileSystem),
    Layer.succeed(FileSystemContextServiceTag, {
      getCwd: () => Effect.succeed(os.tmpdir()),
    } as unknown as FileSystemContextService),
  );
}

describe("park and resume, through the real loop", () => {
  it("parks on a gated tool, then finishes it when the approval arrives", async () => {
    executions = [];
    const store = new InMemoryRunStore();
    const layers = makeLayers(store);

    const parkExit = await Effect.runPromiseExit(
      AgentRunner.run({
        agent: AGENT,
        userInput: "do the gated thing",
        sessionId: "session-1",
        conversationId: "conv-1",
        stream: false,
        parkWhenUnattended: true,
      }).pipe(Effect.provide(layers)) as Effect.Effect<unknown, unknown>,
    );

    expect(parkExit._tag).toBe("Failure");
    expect(executions).toEqual([]);

    const parked = (await Effect.runPromise(store.listActive()))[0];
    expect(parked).toBeDefined();
    if (parked?.state.kind !== "input-required") throw new Error("expected a parked run");
    if (parked.state.pending.kind !== "tool-approval") throw new Error("expected an approval");
    expect(parked.state.pending.request.toolCallId).toBe(TOOL_CALL.id);
    // The transcript has to carry the assistant turn holding the unanswered call, or there
    // is nothing for resume to finish.
    expect(
      parked.state.snapshot.messages.some(
        (message) => message.role === "assistant" && message.tool_calls !== undefined,
      ),
    ).toBe(true);

    const resumeExit = await Effect.runPromiseExit(
      resumeRun({ runId: parked.runId, outcome: { approved: true } }).pipe(
        Effect.provide(layers),
      ) as Effect.Effect<unknown, unknown>,
    );

    expect(resumeExit._tag).toBe("Success");
    // The gated tool ran once, on resume — not during the parked run, and not twice.
    expect(executions).toEqual(["danger_execute"]);

    const finished = await Effect.runPromise(store.get(parked.runId));
    expect(finished?.state.kind).toBe("completed");
    expect(await Effect.runPromise(store.listActive())).toHaveLength(0);
  });

  it("declines instead of parking when parking is not enabled", async () => {
    executions = [];
    const store = new InMemoryRunStore();

    const exit = await Effect.runPromiseExit(
      AgentRunner.run({
        agent: AGENT,
        userInput: "do the gated thing",
        sessionId: "session-3",
        conversationId: "conv-2",
        stream: false,
      }).pipe(Effect.provide(makeLayers(store))) as Effect.Effect<unknown, unknown>,
    );

    expect(exit._tag).toBe("Success");
    expect(executions).toEqual([]);
    if (exit._tag === "Failure") return;
    expect(isRunParkRequested(exit.value)).toBe(false);
  });
});
