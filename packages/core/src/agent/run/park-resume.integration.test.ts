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
import { InMemoryRunStore } from "@jazz/adapters/storage/run-store";
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
import { AgentRunner } from "../agent-runner";
import { isRunParkRequested } from "./park-signal";
import { resumeRun } from "./resume";

const AGENT: Agent = {
  id: "parker",
  name: "parker",
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
/**
 * The `target` of each gated call that actually ran.
 *
 * `executions` records tool names, and two calls of the same gated tool are
 * indistinguishable in it — which is no use for proving an answer landed on the call it was
 * given for rather than its sibling.
 */
let executedTargets: string[] = [];

/** A second gated call, so a batch of two approvals can be asked for. */
const SECOND_TOOL_CALL = {
  id: "call_park_2",
  type: "function" as const,
  function: { name: "danger", arguments: JSON.stringify({ target: "/tmp/y" }) },
};

/** An ungated call, to sit beside a gated one. Runs on sight, which is the whole hazard. */
const SAFE_TOOL_CALL = {
  id: "call_safe_1",
  type: "function" as const,
  function: { name: "harmless", arguments: JSON.stringify({}) },
};

/** A second ungated call, so gated ones can be asked about with others in between. */
const SECOND_SAFE_TOOL_CALL = {
  id: "call_safe_2",
  type: "function" as const,
  function: { name: "harmless", arguments: JSON.stringify({}) },
};

function makeLayers(store: InMemoryRunStore, firstTurnCalls = [TOOL_CALL]) {
  // First completion asks for the gated tool; every later one answers in text. A resumed
  // run must therefore reach the *second* response, which it can only do once the parked
  // tool call has a result.
  let completions = 0;
  const completion = (): ChatCompletionResponse => {
    completions += 1;
    return completions === 1
      ? { id: "c1", model: "gpt-4", content: "", toolCalls: firstTurnCalls }
      : { id: "c2", model: "gpt-4", content: "Done." };
  };

  const logger = {
    debug: mock(() => Effect.void),
    info: mock(() => Effect.void),
    warn: mock(() => Effect.void),
    error: mock(() => Effect.void),
    setLogGroup: mock(() => Effect.void),
    clearLogGroup: mock(() => Effect.void),
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
    getToolDefinitionsFor: mock((names: readonly string[]) =>
      Effect.succeed(
        names.includes("danger")
          ? [{ function: { name: "danger", description: "Does something gated", parameters: {} } }]
          : [],
      ),
    ),
    getToolSummaries: mock(() => Effect.succeed([])),
    partitionByTier: mock((names: readonly string[]) =>
      Effect.succeed({ eager: names, deferred: [] }),
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
      if (typeof args["target"] === "string") executedTargets.push(args["target"]);
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
        conversationId: "conv-1",
        stream: false,
        parkWhenUnattended: true,
      }).pipe(Effect.provide(layers)) as Effect.Effect<unknown, unknown>,
    );

    expect(parkExit._tag).toBe("Failure");
    expect(executions).toEqual([]);

    const parked = (await Effect.runPromise(store.list()))[0];
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
      resumeRun({
        runId: parked.runId,
        outcome: { kind: "approval", value: { approved: true } },
      }).pipe(Effect.provide(layers)) as Effect.Effect<unknown, unknown>,
    );

    expect(resumeExit._tag).toBe("Success");
    // The gated tool ran once, on resume — not during the parked run, and not twice.
    expect(executions).toEqual(["danger_execute"]);

    const finished = await Effect.runPromise(store.get(parked.runId));
    expect(finished?.state.kind).toBe("completed");
    expect(await Effect.runPromise(store.list())).toHaveLength(0);
  });

  it("declines instead of parking when parking is not enabled", async () => {
    executions = [];
    const store = new InMemoryRunStore();

    const exit = await Effect.runPromiseExit(
      AgentRunner.run({
        agent: AGENT,
        userInput: "do the gated thing",
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

describe("a batch of gated calls, with nobody in the room to answer", () => {
  it("parks on the gated one without letting its ungated sibling run", async () => {
    // A batch used to be unparkable at all, for a real reason: resuming replays it, so a
    // sibling that had already executed would run twice. Deciding before anything is forked
    // removes that — nothing has run by the time the run parks, so the replay is clean.
    executions = [];
    const store = new InMemoryRunStore();
    const layers = makeLayers(store, [SAFE_TOOL_CALL, TOOL_CALL]);

    const exit = await Effect.runPromiseExit(
      AgentRunner.run({
        agent: AGENT,
        userInput: "do one of each",
        conversationId: "conv-batch",
        stream: false,
        parkWhenUnattended: true,
      }).pipe(Effect.provide(layers)) as Effect.Effect<unknown, unknown>,
    );

    expect(exit._tag).toBe("Failure");
    // The ungated tool did not run. Before this it would have, and then again on resume.
    expect(executions).toEqual([]);

    const parked = (await Effect.runPromise(store.list()))[0];
    if (parked?.state.kind !== "input-required") throw new Error("expected a parked run");
    if (parked.state.pending.kind !== "tool-approval") throw new Error("expected an approval");
    expect(parked.state.pending.request.toolCallId).toBe(TOOL_CALL.id);

    // Approving it finishes the batch, and each tool runs exactly once.
    const resumeExit = await Effect.runPromiseExit(
      resumeRun({
        runId: parked.runId,
        outcome: { kind: "approval", value: { approved: true } },
      }).pipe(Effect.provide(layers)) as Effect.Effect<unknown, unknown>,
    );
    expect(resumeExit._tag).toBe("Success");
    expect(executions.filter((name) => name === "danger_execute")).toHaveLength(1);
    expect(executions.filter((name) => name === "harmless")).toHaveLength(1);
  });

  it("asks for each approval in turn, and runs each tool exactly once", async () => {
    // Two approvals in one turn used to be refused outright, because each resume rebuilt its
    // answers from the one outcome it was handed: answering the first stopped on the second,
    // and answering that stopped on the first again. A parked run now carries what has
    // already been answered, so the rounds converge.
    executions = [];
    const store = new InMemoryRunStore();
    const layers = makeLayers(store, [TOOL_CALL, SECOND_TOOL_CALL]);

    await Effect.runPromiseExit(
      AgentRunner.run({
        agent: AGENT,
        userInput: "do both gated things",
        conversationId: "conv-batch-2",
        stream: false,
        parkWhenUnattended: true,
      }).pipe(Effect.provide(layers)) as Effect.Effect<unknown, unknown>,
    );

    const askedAbout: string[] = [];
    for (let round = 0; round < 5; round += 1) {
      const parked = (await Effect.runPromise(store.list()))[0];
      if (parked === undefined) break;
      if (parked.state.kind !== "input-required") throw new Error("expected a parked run");
      if (parked.state.pending.kind !== "tool-approval") throw new Error("expected an approval");
      askedAbout.push(parked.state.pending.request.toolCallId);
      // Nothing may have run while approvals are still outstanding.
      if (round === 0) expect(executions).toEqual([]);
      await Effect.runPromiseExit(
        resumeRun({
          runId: parked.runId,
          outcome: { kind: "approval", value: { approved: true } },
        }).pipe(Effect.provide(layers)) as Effect.Effect<unknown, unknown>,
      );
    }

    // Asked about each call once, in order, and never asked about the same one twice.
    expect(askedAbout).toEqual([TOOL_CALL.id, SECOND_TOOL_CALL.id]);
    expect(executions).toEqual(["danger_execute", "danger_execute"]);
    expect(await Effect.runPromise(store.list())).toHaveLength(0);
  });

  it("remembers an answer across the park that follows it", async () => {
    executions = [];
    const store = new InMemoryRunStore();
    const layers = makeLayers(store, [TOOL_CALL, SECOND_TOOL_CALL]);

    await Effect.runPromiseExit(
      AgentRunner.run({
        agent: AGENT,
        userInput: "do both gated things",
        conversationId: "conv-batch-3",
        stream: false,
        parkWhenUnattended: true,
      }).pipe(Effect.provide(layers)) as Effect.Effect<unknown, unknown>,
    );

    const first = (await Effect.runPromise(store.list()))[0];
    if (first?.state.kind !== "input-required") throw new Error("expected a parked run");
    // The first park has nothing to remember yet.
    expect(first.state.snapshot.pendingTurnAnswers).toBeUndefined();

    await Effect.runPromiseExit(
      resumeRun({
        runId: first.runId,
        outcome: { kind: "approval", value: { approved: true } },
      }).pipe(Effect.provide(layers)) as Effect.Effect<unknown, unknown>,
    );

    const second = (await Effect.runPromise(store.list()))[0];
    if (second?.state.kind !== "input-required") throw new Error("expected a second park");
    // The second one is where it matters: without this the next resume forgets round one.
    expect(Object.keys(second.state.snapshot.pendingTurnAnswers ?? {})).toEqual([TOOL_CALL.id]);
  });
});

describe("the order approvals are asked in, and who each answer belongs to", () => {
  /** Answer each park in turn, recording which call was asked about. */
  async function answerEach(
    store: InMemoryRunStore,
    layers: ReturnType<typeof makeLayers>,
    decide: (toolCallId: string) => boolean,
  ): Promise<string[]> {
    const askedAbout: string[] = [];
    for (let round = 0; round < 6; round += 1) {
      const parked = (await Effect.runPromise(store.list()))[0];
      if (parked === undefined) break;
      if (parked.state.kind !== "input-required") throw new Error("expected a parked run");
      if (parked.state.pending.kind !== "tool-approval") throw new Error("expected an approval");
      const toolCallId = parked.state.pending.request.toolCallId;
      askedAbout.push(toolCallId);
      await Effect.runPromiseExit(
        resumeRun({
          runId: parked.runId,
          outcome: { kind: "approval", value: { approved: decide(toolCallId) } },
        }).pipe(Effect.provide(layers)) as Effect.Effect<unknown, unknown>,
      );
    }
    return askedAbout;
  }

  async function fire(
    layers: ReturnType<typeof makeLayers>,
    conversationId: string,
  ): Promise<void> {
    await Effect.runPromiseExit(
      AgentRunner.run({
        agent: AGENT,
        userInput: "do the things",
        conversationId,
        stream: false,
        parkWhenUnattended: true,
      }).pipe(Effect.provide(layers)) as Effect.Effect<unknown, unknown>,
    );
  }

  it("asks in the order the model asked, with ungated calls in between", async () => {
    executions = [];
    executedTargets = [];
    const store = new InMemoryRunStore();
    const layers = makeLayers(store, [
      SAFE_TOOL_CALL,
      TOOL_CALL,
      SECOND_SAFE_TOOL_CALL,
      SECOND_TOOL_CALL,
    ]);
    await fire(layers, "conv-order-1");

    const askedAbout = await answerEach(store, layers, () => true);

    // The model's own order, not the order the scan happened to reach them in.
    expect(askedAbout).toEqual([TOOL_CALL.id, SECOND_TOOL_CALL.id]);
    expect(executedTargets).toEqual(["/tmp/x", "/tmp/y"]);
  });

  it("asks in that order even when the first is rejected", async () => {
    executions = [];
    executedTargets = [];
    const store = new InMemoryRunStore();
    const layers = makeLayers(store, [TOOL_CALL, SECOND_TOOL_CALL]);
    await fire(layers, "conv-order-2");

    const askedAbout = await answerEach(store, layers, (id) => id !== TOOL_CALL.id);

    // A rejection is an answer, so it does not come round again.
    expect(askedAbout).toEqual([TOOL_CALL.id, SECOND_TOOL_CALL.id]);
  });

  it("applies a rejection to the call it was given for, not its sibling", async () => {
    executions = [];
    executedTargets = [];
    const store = new InMemoryRunStore();
    const layers = makeLayers(store, [TOOL_CALL, SECOND_TOOL_CALL]);
    await fire(layers, "conv-order-3");

    await answerEach(store, layers, (id) => id !== TOOL_CALL.id);

    // Both are calls of the same gated tool, so only the arguments tell them apart. The
    // rejected one must not have run and the approved one must have.
    expect(executedTargets).toEqual(["/tmp/y"]);
  });

  it("applies a rejection of the second call the same way round", async () => {
    executions = [];
    executedTargets = [];
    const store = new InMemoryRunStore();
    const layers = makeLayers(store, [TOOL_CALL, SECOND_TOOL_CALL]);
    await fire(layers, "conv-order-4");

    await answerEach(store, layers, (id) => id !== SECOND_TOOL_CALL.id);

    expect(executedTargets).toEqual(["/tmp/x"]);
  });

  it("runs nothing at all when every call is rejected", async () => {
    executions = [];
    executedTargets = [];
    const store = new InMemoryRunStore();
    const layers = makeLayers(store, [TOOL_CALL, SECOND_TOOL_CALL]);
    await fire(layers, "conv-order-5");

    await answerEach(store, layers, () => false);

    expect(executedTargets).toEqual([]);
    expect(await Effect.runPromise(store.list())).toHaveLength(0);
  });
});
