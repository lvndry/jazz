import { FileSystem } from "@effect/platform";
import { describe, expect, it, mock } from "bun:test";
import { Effect, Layer, Stream } from "effect";
import { AgentRunner } from "@/core/agent/agent-runner";
import type { AgentConfigService } from "@/core/interfaces/agent-config";
import { AgentConfigServiceTag } from "@/core/interfaces/agent-config";
import type { FileSystemContextService } from "@/core/interfaces/fs";
import { FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { LLMService } from "@/core/interfaces/llm";
import { LLMServiceTag } from "@/core/interfaces/llm";
import type { LoggerService } from "@/core/interfaces/logger";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import type { MCPServerManager } from "@/core/interfaces/mcp-server";
import { MCPServerManagerTag } from "@/core/interfaces/mcp-server";
import type { PresentationService } from "@/core/interfaces/presentation";
import { PresentationServiceTag } from "@/core/interfaces/presentation";
import type { TerminalService } from "@/core/interfaces/terminal";
import { TerminalServiceTag } from "@/core/interfaces/terminal";
import { ToolRegistryTag, type ToolRegistry } from "@/core/interfaces/tool-registry";
import { SkillServiceTag, type SkillService } from "@/core/skills/skill-service";
import type { Agent, CustomToolDefinition } from "@/core/types/agent";
import { AgentConfigurationError } from "@/core/types/errors";
import type { ToolExecutionResult } from "@/core/types/tools";
import { registerCustomToolsForAgent } from "./custom-tools";
import { createToolRegistryLayer } from "./tool-registry";

// ---------------------------------------------------------------------------
// Unit tests: registerCustomToolsForAgent against a lightweight mock registry
// ---------------------------------------------------------------------------

const mockLogger: LoggerService = {
  debug: mock(() => Effect.void),
  info: mock(() => Effect.void),
  warn: mock(() => Effect.void),
  error: mock(() => Effect.void),
  setSessionId: mock(() => Effect.void),
  clearSessionId: mock(() => Effect.void),
  writeToFile: mock(() => Effect.void),
  logToolCall: mock(() => Effect.void),
} as unknown as LoggerService;

function makeAgent(customTools: readonly CustomToolDefinition[], tools: readonly string[]): Agent {
  return {
    id: "agent-1",
    name: "Test Agent",
    model: "openai/gpt-4",
    config: {
      persona: "default",
      llmProvider: "openai",
      llmModel: "gpt-4",
      tools,
      customTools,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeMockRegistry(existingToolNames: readonly string[]) {
  const registered: Array<{ name: string }> = [];
  const registry = {
    registerTool: mock((tool: { name: string }) => {
      registered.push({ name: tool.name });
      return Effect.succeed(undefined);
    }),
    registerForCategory: mock(() => mock(() => Effect.succeed(undefined))),
    listAllTools: mock(() => Effect.succeed(existingToolNames)),
    listTools: mock(() => Effect.succeed(existingToolNames)),
    getTool: mock(() => Effect.fail(new Error("not found"))),
    getToolDefinitions: mock(() => Effect.succeed([])),
    listToolsByCategory: mock(() => Effect.succeed({})),
    getToolsInCategory: mock(() => Effect.succeed([])),
    listCategories: mock(() => Effect.succeed([])),
    executeTool: mock(() => Effect.succeed({ success: true, result: null })),
  } as unknown as ToolRegistry;
  return { registry, registered };
}

function runWithRegistry<A>(
  program: Effect.Effect<A, Error, ToolRegistry | LoggerService>,
  registry: ToolRegistry,
): Promise<A> {
  return Effect.runPromise(
    program.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ToolRegistryTag, registry),
          Layer.succeed(LoggerServiceTag, mockLogger),
        ),
      ),
    ),
  );
}

const recordToolDefinition: CustomToolDefinition = {
  name: "propose_action",
  description: "Propose an action for a human to review.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", description: "The action being proposed" },
    },
    required: ["action"],
  },
  handler: { type: "record", response: "Custom response!" },
};

describe("registerCustomToolsForAgent", () => {
  it("only registers custom tools whose name is in the agent's tool list", async () => {
    const otherTool: CustomToolDefinition = {
      ...recordToolDefinition,
      name: "not_selected",
    };
    const { registry, registered } = makeMockRegistry([]);
    const agent = makeAgent([recordToolDefinition, otherTool], ["propose_action"]);

    await runWithRegistry(registerCustomToolsForAgent(agent, agent.config.tools ?? []), registry);

    expect(registered).toEqual([{ name: "propose_action" }]);
  });

  it("does nothing when the agent declares no custom tools", async () => {
    const { registry, registered } = makeMockRegistry([]);
    const agent = makeAgent([], ["propose_action"]);

    await runWithRegistry(registerCustomToolsForAgent(agent, agent.config.tools ?? []), registry);

    expect(registered).toEqual([]);
  });

  it("fails startup with AgentConfigurationError on a name collision", async () => {
    const { registry } = makeMockRegistry(["propose_action"]);
    const agent = makeAgent([recordToolDefinition], ["propose_action"]);

    const result = await Effect.runPromise(
      Effect.either(
        registerCustomToolsForAgent(agent, agent.config.tools ?? []).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(ToolRegistryTag, registry),
              Layer.succeed(LoggerServiceTag, mockLogger),
            ),
          ),
        ),
      ),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(AgentConfigurationError);
      expect(String((result.left as AgentConfigurationError).message)).toContain("propose_action");
    }
  });

  it("registers command-handler entries (execution behavior covered in the command-handler suite below)", async () => {
    const commandToolDefinition: CustomToolDefinition = {
      name: "run_command",
      description: "Runs a shell command",
      parameters: { type: "object", properties: {} },
      handler: { type: "command", command: ["echo", "hi"] },
    };
    const { registry, registered } = makeMockRegistry([]);
    const agent = makeAgent([commandToolDefinition], ["run_command"]);

    await runWithRegistry(registerCustomToolsForAgent(agent, agent.config.tools ?? []), registry);

    expect(registered).toEqual([{ name: "run_command" }]);
  });

  it("record handler execute returns the configured canned response", async () => {
    const { registry, registered: _registered } = makeMockRegistry([]);
    const agent = makeAgent([recordToolDefinition], ["propose_action"]);

    let capturedTool:
      | {
          execute: (
            args: Record<string, unknown>,
            context: unknown,
          ) => Effect.Effect<unknown, unknown, unknown>;
        }
      | undefined;
    (registry.registerTool as unknown as ReturnType<typeof mock>) = mock((tool: any) => {
      capturedTool = tool;
      return Effect.succeed(undefined);
    });

    await runWithRegistry(registerCustomToolsForAgent(agent, agent.config.tools ?? []), registry);

    expect(capturedTool).toBeDefined();
    const result = await Effect.runPromise(
      capturedTool!.execute({ action: "do_something" }, { agentId: "agent-1" }) as Effect.Effect<
        { success: boolean; result: unknown },
        never,
        never
      >,
    );
    expect(result).toEqual({ success: true, result: "Custom response!" });
  });

  it("record handler defaults to 'Recorded.' when no response is configured", async () => {
    const definitionWithoutResponse: CustomToolDefinition = {
      ...recordToolDefinition,
      handler: { type: "record" },
    };
    const { registry } = makeMockRegistry([]);
    const agent = makeAgent([definitionWithoutResponse], ["propose_action"]);

    let capturedTool: any;
    (registry.registerTool as unknown as ReturnType<typeof mock>) = mock((tool: any) => {
      capturedTool = tool;
      return Effect.succeed(undefined);
    });

    await runWithRegistry(registerCustomToolsForAgent(agent, agent.config.tools ?? []), registry);

    const result = await Effect.runPromise(
      capturedTool.execute({ action: "do_something" }, { agentId: "agent-1" }),
    );
    expect(result).toEqual({ success: true, result: "Recorded." });
  });

  it("rejects args that fail the converted zod schema, same as MCP tool args", async () => {
    const { registry } = makeMockRegistry([]);
    const agent = makeAgent([recordToolDefinition], ["propose_action"]);

    let capturedTool: any;
    (registry.registerTool as unknown as ReturnType<typeof mock>) = mock((tool: any) => {
      capturedTool = tool;
      return Effect.succeed(undefined);
    });

    await runWithRegistry(registerCustomToolsForAgent(agent, agent.config.tools ?? []), registry);

    // "action" is required by the schema but omitted here.
    const result = await Effect.runPromise(capturedTool.execute({}, { agentId: "agent-1" }));
    expect(result.success).toBe(false);
    expect(String(result.error ?? "")).toContain("action");
  });
});

// ---------------------------------------------------------------------------
// Integration test: drive a full AgentRunner.run() with a scripted LLM that
// calls the custom tool, and assert it surfaces in the run's `toolCalls`
// (the same field run-agent.ts's JSON envelope reads from `runResult.toolCalls`).
// ---------------------------------------------------------------------------

describe("custom tools surfaced through AgentRunner.run toolCalls", () => {
  const mockPresentationService: PresentationService = {
    presentThinking: mock(() => Effect.void),
    presentThinkingEnd: mock(() => Effect.void),
    createStreamingRenderer: mock(() =>
      Effect.succeed({
        renderEvent: mock(() => Effect.void),
        stop: mock(() => Effect.void),
        handleEvent: mock(() => Effect.void),
        setInterruptHandler: mock(() => Effect.void),
        reset: mock(() => Effect.void),
        flush: mock(() => Effect.void),
      }),
    ),
    renderMarkdown: mock((content: string) => Effect.succeed(content)),
    presentAgentResponse: mock(() => Effect.void),
    presentCompletion: mock(() => Effect.void),
    presentWarning: mock(() => Effect.void),
    presentStatus: mock(() => Effect.void),
    writeOutput: mock(() => Effect.void),
    writeBlankLine: mock(() => Effect.void),
    formatToolExecutionStart: mock(() => Effect.succeed("Tool starting")),
    formatToolExecutionComplete: mock(() => Effect.succeed("Tool completed")),
    formatToolResult: mock(() => "Tool result"),
    formatToolExecutionError: mock(() => Effect.succeed("Tool failed")),
    formatToolsDetected: mock(() => Effect.succeed("Tools detected")),
    requestApproval: mock(() => Effect.succeed({ approved: true as const })),
  } as unknown as PresentationService;

  const mockTerminalService = {} as unknown as TerminalService;
  const mockFileSystem = {} as unknown as FileSystem.FileSystem;
  const mockFileSystemContext = {} as unknown as FileSystemContextService;

  const mockSkillService = {
    listSkills: mock(() => Effect.succeed([])),
  } as unknown as SkillService;

  const mockAppConfig = {
    output: {
      showMetrics: true,
      streaming: { enabled: false, textBufferMs: 100 },
      mode: "markdown" as const,
    },
    llm: { openai: { api_key: "test-key" } },
  };

  const mockAgentConfigService = {
    appConfig: Effect.succeed(mockAppConfig),
    get: mock(() => Effect.succeed(undefined)),
    getOrElse: mock((_key: string, fallback: unknown) => Effect.succeed(fallback)),
    getOrFail: mock(() => Effect.succeed(undefined)),
    has: mock(() => Effect.succeed(false)),
    set: mock(() => Effect.void),
  } as unknown as AgentConfigService;

  const mockMcpServerManager = {
    connectServer: mock(() => Effect.fail(new Error("Not implemented"))),
    disconnectServer: mock(() => Effect.void),
    getServerTools: mock(() => Effect.succeed([])),
    discoverTools: mock(() => Effect.succeed([])),
    listServers: mock(() => Effect.succeed([])),
    isConnected: mock(() => Effect.succeed(false)),
    disconnectAllServers: mock(() => Effect.void),
  } as unknown as MCPServerManager;

  it("propagates a custom-tool call into runResult.toolCalls with the canned response as the model-visible result", async () => {
    let callCount = 0;
    const mockLlmService: LLMService = {
      getProvider: mock(() =>
        Effect.succeed({
          name: "openai",
          supportedModels: [{ id: "gpt-4", supportsTools: true }],
          defaultModel: "gpt-4",
          authenticate: () => Effect.void,
        }),
      ),
      listProviders: mock(() => Effect.succeed([])),
      createChatCompletion: mock(() => {
        callCount++;
        if (callCount === 1) {
          return Effect.succeed({
            id: "completion-1",
            model: "gpt-4",
            content: "",
            toolCalls: [
              {
                id: "call_1",
                type: "function" as const,
                function: {
                  name: "propose_action",
                  arguments: JSON.stringify({ action: "do_something" }),
                },
              },
            ],
          });
        }
        return Effect.succeed({
          id: "completion-2",
          model: "gpt-4",
          content: "Done.",
        });
      }),
      createStreamingChatCompletion: mock(() =>
        Effect.succeed({
          stream: Stream.empty,
          response: Effect.succeed({ id: "unused", model: "gpt-4", content: "unused" }),
          cancel: Effect.void,
        }),
      ),
      supportsNativeWebSearch: mock(() => Effect.succeed(false)),
    } as unknown as LLMService;

    const agent: Agent = {
      id: "agent-with-custom-tool",
      name: "Custom Tool Agent",
      model: "openai/gpt-4",
      config: {
        persona: "default",
        llmProvider: "openai",
        llmModel: "gpt-4",
        tools: ["propose_action"],
        customTools: [recordToolDefinition],
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const testLayer = Layer.mergeAll(
      Layer.succeed(LoggerServiceTag, mockLogger),
      Layer.succeed(PresentationServiceTag, mockPresentationService),
      Layer.succeed(SkillServiceTag, mockSkillService),
      Layer.succeed(AgentConfigServiceTag, mockAgentConfigService),
      Layer.succeed(MCPServerManagerTag, mockMcpServerManager),
      Layer.succeed(LLMServiceTag, mockLlmService),
      Layer.succeed(TerminalServiceTag, mockTerminalService),
      Layer.succeed(FileSystem.FileSystem, mockFileSystem),
      Layer.succeed(FileSystemContextServiceTag, mockFileSystemContext),
    );

    const realToolRegistryLayer = createToolRegistryLayer();

    const runResult = await Effect.runPromise(
      AgentRunner.run({
        agent,
        userInput: "please propose an action",
        sessionId: "test-session-custom-tool",
        stream: false,
        maxIterations: 3,
      }).pipe(Effect.provide(Layer.mergeAll(testLayer, realToolRegistryLayer))) as Effect.Effect<
        import("../types").AgentResponse,
        never,
        never
      >,
    );

    expect(runResult.content).toBe("Done.");

    const toolCalls = (runResult.toolCalls ?? []).map((toolCall) => ({
      name: toolCall.function?.name ?? "",
      arguments: toolCall.function?.arguments ?? "",
    }));
    expect(toolCalls).toEqual([
      { name: "propose_action", arguments: JSON.stringify({ action: "do_something" }) },
    ]);

    expect(runResult.toolResults?.["propose_action"]).toBe("Custom response!");
  });

  it("re-registers the same custom tool across two AgentRunner.run calls sharing one registry", async () => {
    let callCount = 0;
    const mockLlmService: LLMService = {
      getProvider: mock(() =>
        Effect.succeed({
          name: "openai",
          supportedModels: [{ id: "gpt-4", supportsTools: true }],
          defaultModel: "gpt-4",
          authenticate: () => Effect.void,
        }),
      ),
      listProviders: mock(() => Effect.succeed([])),
      createChatCompletion: mock(() => {
        callCount++;
        // Every run calls the tool on its first LLM turn, then wraps up.
        if (callCount % 2 === 1) {
          return Effect.succeed({
            id: `completion-${callCount}`,
            model: "gpt-4",
            content: "",
            toolCalls: [
              {
                id: `call_${callCount}`,
                type: "function" as const,
                function: {
                  name: "propose_action",
                  arguments: JSON.stringify({ action: "do_something" }),
                },
              },
            ],
          });
        }
        return Effect.succeed({
          id: `completion-${callCount}`,
          model: "gpt-4",
          content: "Done.",
        });
      }),
      createStreamingChatCompletion: mock(() =>
        Effect.succeed({
          stream: Stream.empty,
          response: Effect.succeed({ id: "unused", model: "gpt-4", content: "unused" }),
          cancel: Effect.void,
        }),
      ),
      supportsNativeWebSearch: mock(() => Effect.succeed(false)),
    } as unknown as LLMService;

    const agent: Agent = {
      id: "agent-with-custom-tool-two-turns",
      name: "Custom Tool Agent",
      model: "openai/gpt-4",
      config: {
        persona: "default",
        llmProvider: "openai",
        llmModel: "gpt-4",
        tools: ["propose_action"],
        customTools: [recordToolDefinition],
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const testLayer = Layer.mergeAll(
      Layer.succeed(LoggerServiceTag, mockLogger),
      Layer.succeed(PresentationServiceTag, mockPresentationService),
      Layer.succeed(SkillServiceTag, mockSkillService),
      Layer.succeed(AgentConfigServiceTag, mockAgentConfigService),
      Layer.succeed(MCPServerManagerTag, mockMcpServerManager),
      Layer.succeed(LLMServiceTag, mockLlmService),
      Layer.succeed(TerminalServiceTag, mockTerminalService),
      Layer.succeed(FileSystem.FileSystem, mockFileSystem),
      Layer.succeed(FileSystemContextServiceTag, mockFileSystemContext),
    );

    // A single ToolRegistry layer, shared across both `run` calls below,
    // mirrors the session-lifetime singleton in app-layer.ts: registration
    // runs on every AgentRunner.run against the SAME registry instance.
    const sharedToolRegistryLayer = createToolRegistryLayer();
    const runLayer = Layer.mergeAll(testLayer, sharedToolRegistryLayer);

    const runOptions = {
      agent,
      userInput: "please propose an action",
      sessionId: "test-session-custom-tool-two-turns",
      stream: false,
      maxIterations: 3,
    };

    const firstRun = await Effect.runPromise(
      AgentRunner.run(runOptions).pipe(Effect.provide(runLayer)) as Effect.Effect<
        import("../types").AgentResponse,
        never,
        never
      >,
    );
    expect(firstRun.content).toBe("Done.");
    expect(firstRun.toolResults?.["propose_action"]).toBe("Custom response!");

    // Second run reuses the same registry, exactly like a second chat turn in
    // the same session: registration must be idempotent instead of throwing.
    const secondRun = await Effect.runPromise(
      AgentRunner.run(runOptions).pipe(Effect.provide(runLayer)) as Effect.Effect<
        import("../types").AgentResponse,
        never,
        never
      >,
    );
    expect(secondRun.content).toBe("Done.");
    expect(secondRun.toolResults?.["propose_action"]).toBe("Custom response!");
  });

  it("fails with AgentConfigurationError when a second run declares a CHANGED definition for the same name", async () => {
    const mockLlmService: LLMService = {
      getProvider: mock(() =>
        Effect.succeed({
          name: "openai",
          supportedModels: [{ id: "gpt-4", supportsTools: true }],
          defaultModel: "gpt-4",
          authenticate: () => Effect.void,
        }),
      ),
      listProviders: mock(() => Effect.succeed([])),
      createChatCompletion: mock(() =>
        Effect.succeed({
          id: "completion-1",
          model: "gpt-4",
          content: "",
          toolCalls: [
            {
              id: "call_1",
              type: "function" as const,
              function: {
                name: "propose_action",
                arguments: JSON.stringify({ action: "do_something" }),
              },
            },
          ],
        }),
      ),
      createStreamingChatCompletion: mock(() =>
        Effect.succeed({
          stream: Stream.empty,
          response: Effect.succeed({ id: "unused", model: "gpt-4", content: "unused" }),
          cancel: Effect.void,
        }),
      ),
      supportsNativeWebSearch: mock(() => Effect.succeed(false)),
    } as unknown as LLMService;

    const testLayer = Layer.mergeAll(
      Layer.succeed(LoggerServiceTag, mockLogger),
      Layer.succeed(PresentationServiceTag, mockPresentationService),
      Layer.succeed(SkillServiceTag, mockSkillService),
      Layer.succeed(AgentConfigServiceTag, mockAgentConfigService),
      Layer.succeed(MCPServerManagerTag, mockMcpServerManager),
      Layer.succeed(LLMServiceTag, mockLlmService),
      Layer.succeed(TerminalServiceTag, mockTerminalService),
      Layer.succeed(FileSystem.FileSystem, mockFileSystem),
      Layer.succeed(FileSystemContextServiceTag, mockFileSystemContext),
    );

    const sharedToolRegistryLayer = createToolRegistryLayer();
    const runLayer = Layer.mergeAll(testLayer, sharedToolRegistryLayer);

    const firstAgent: Agent = {
      id: "agent-original-definition",
      name: "Custom Tool Agent",
      model: "openai/gpt-4",
      config: {
        persona: "default",
        llmProvider: "openai",
        llmModel: "gpt-4",
        tools: ["propose_action"],
        customTools: [recordToolDefinition],
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const firstRun = await Effect.runPromise(
      AgentRunner.run({
        agent: firstAgent,
        userInput: "please propose an action",
        sessionId: "test-session-changed-definition",
        stream: false,
        maxIterations: 3,
      }).pipe(Effect.provide(runLayer)) as Effect.Effect<
        import("../types").AgentResponse,
        never,
        never
      >,
    );
    expect(firstRun.toolResults?.["propose_action"]).toBe("Custom response!");

    const changedDefinition: CustomToolDefinition = {
      ...recordToolDefinition,
      handler: { type: "record", response: "A completely different response!" },
    };
    const secondAgent: Agent = {
      ...firstAgent,
      id: "agent-changed-definition",
      config: {
        ...firstAgent.config,
        customTools: [changedDefinition],
      },
    };

    const secondRunResult = await Effect.runPromise(
      Effect.either(
        AgentRunner.run({
          agent: secondAgent,
          userInput: "please propose an action",
          sessionId: "test-session-changed-definition-2",
          stream: false,
          maxIterations: 3,
        }).pipe(Effect.provide(runLayer)) as Effect.Effect<
          import("../types").AgentResponse,
          Error,
          never
        >,
      ),
    );

    expect(secondRunResult._tag).toBe("Left");
    if (secondRunResult._tag === "Left") {
      expect(secondRunResult.left).toBeInstanceOf(AgentConfigurationError);
      expect(String((secondRunResult.left as AgentConfigurationError).message)).toContain(
        "propose_action",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// command-handler custom tools: real-process tests. Each definition spawns
// `node -e <script>` directly (no shell), exercising the actual child_process
// wiring in `buildCommandTool` rather than mocking it away.
// ---------------------------------------------------------------------------

describe("registerCustomToolsForAgent: command-handler execution", () => {
  function makeFsContext(cwd: string): FileSystemContextService {
    return {
      getCwd: () => Effect.succeed(cwd),
      setCwd: () => Effect.void,
      resolvePath: (_key: unknown, path: string) => Effect.succeed(path),
      findDirectory: () => Effect.succeed({ results: [] as readonly string[] }),
      resolvePathForMkdir: (_key: unknown, path: string) => Effect.succeed(path),
      escapePath: (path: string) => path,
    } as unknown as FileSystemContextService;
  }

  async function registerAndCapture(definition: CustomToolDefinition): Promise<{
    execute: (
      args: Record<string, unknown>,
      context: Record<string, unknown>,
    ) => Effect.Effect<ToolExecutionResult, unknown, FileSystemContextService | LoggerService>;
  }> {
    const { registry } = makeMockRegistry([]);
    let capturedTool: unknown;
    (registry.registerTool as unknown as ReturnType<typeof mock>) = mock((tool: unknown) => {
      capturedTool = tool;
      return Effect.succeed(undefined);
    });
    const agent = makeAgent([definition], [definition.name]);

    await runWithRegistry(registerCustomToolsForAgent(agent, agent.config.tools ?? []), registry);

    return capturedTool as {
      execute: (
        args: Record<string, unknown>,
        context: Record<string, unknown>,
      ) => Effect.Effect<ToolExecutionResult, unknown, FileSystemContextService | LoggerService>;
    };
  }

  function runTool(
    effect: Effect.Effect<ToolExecutionResult, unknown, FileSystemContextService | LoggerService>,
    cwd: string = process.cwd(),
  ): Promise<ToolExecutionResult> {
    return Effect.runPromise(
      effect.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(FileSystemContextServiceTag, makeFsContext(cwd)),
            Layer.succeed(LoggerServiceTag, mockLogger),
          ),
        ),
      ) as Effect.Effect<ToolExecutionResult, never, never>,
    );
  }

  it("delivers the validated tool arguments as JSON on the command's stdin", async () => {
    const definition: CustomToolDefinition = {
      name: "echo_stdin",
      description: "Echoes stdin back to stdout",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
      handler: {
        type: "command",
        command: [
          "node",
          "-e",
          "let data='';process.stdin.on('data',(c)=>{data+=c;});process.stdin.on('end',()=>{process.stdout.write(data);});",
        ],
      },
    };

    const tool = await registerAndCapture(definition);
    const result = await runTool(tool.execute({ value: "hello" }, { agentId: "agent-1" }));

    expect(result.success).toBe(true);
    expect(result.result).toBe(JSON.stringify({ value: "hello" }));
  });

  it("returns an error result carrying stderr when the command exits non-zero", async () => {
    const definition: CustomToolDefinition = {
      name: "fail_command",
      description: "Always fails with stderr output",
      parameters: { type: "object", properties: {} },
      handler: {
        type: "command",
        command: ["node", "-e", "process.stderr.write('boom'); process.exit(1);"],
      },
    };

    const tool = await registerAndCapture(definition);
    const result = await runTool(tool.execute({}, { agentId: "agent-1" }));

    expect(result.success).toBe(false);
    expect(result.result).toBeNull();
    expect(String(result.error ?? "")).toContain("boom");
    expect(String(result.error ?? "")).toContain("1");
  });

  it("kills the command and returns a timeout error when it runs past timeoutMs", async () => {
    const definition: CustomToolDefinition = {
      name: "slow_command",
      description: "Sleeps well past the configured timeout",
      parameters: { type: "object", properties: {} },
      handler: {
        type: "command",
        command: ["node", "-e", "setTimeout(() => {}, 5000);"],
        timeoutMs: 150,
      },
    };

    const tool = await registerAndCapture(definition);
    const start = Date.now();
    const result = await runTool(tool.execute({}, { agentId: "agent-1" }));
    const elapsedMs = Date.now() - start;

    expect(result.success).toBe(false);
    expect(result.result).toBeNull();
    expect(String(result.error ?? "").toLowerCase()).toContain("timed out");
    // Should be killed close to timeoutMs, nowhere near the 5s sleep.
    expect(elapsedMs).toBeLessThan(4000);
  });

  it("caps stdout at 16 KB even when the command writes far more", async () => {
    const definition: CustomToolDefinition = {
      name: "huge_stdout",
      description: "Writes 200 KB of output",
      parameters: { type: "object", properties: {} },
      handler: {
        type: "command",
        command: ["node", "-e", "process.stdout.write('a'.repeat(200 * 1024));"],
      },
    };

    const tool = await registerAndCapture(definition);
    const result = await runTool(tool.execute({}, { agentId: "agent-1" }));

    expect(result.success).toBe(true);
    expect(typeof result.result).toBe("string");
    expect((result.result as string).length).toBe(16 * 1024);
  });

  it("scrubs a sensitive-name env var by default, but passes it through when allowlisted", async () => {
    const originalValue = process.env["FAKE_TOKEN"];
    process.env["FAKE_TOKEN"] = "supersecret";

    try {
      const definition: CustomToolDefinition = {
        name: "print_env",
        description: "Prints FAKE_TOKEN from its environment",
        parameters: { type: "object", properties: {} },
        handler: {
          type: "command",
          command: ["node", "-e", "process.stdout.write(process.env.FAKE_TOKEN || '')"],
        },
      };

      const tool = await registerAndCapture(definition);

      const withoutAllowlist = await runTool(tool.execute({}, { agentId: "agent-1" }));
      expect(withoutAllowlist.success).toBe(true);
      expect(withoutAllowlist.result).toBe("");

      const parentAgent: Agent = {
        id: "agent-1",
        name: "Test Agent",
        model: "openai/gpt-4",
        config: {
          persona: "default",
          llmProvider: "openai",
          llmModel: "gpt-4",
          envAllowlist: ["FAKE_TOKEN"],
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const withAllowlist = await runTool(tool.execute({}, { agentId: "agent-1", parentAgent }));
      expect(withAllowlist.success).toBe(true);
      expect(withAllowlist.result).toBe("supersecret");
    } finally {
      if (originalValue === undefined) {
        delete process.env["FAKE_TOKEN"];
      } else {
        process.env["FAKE_TOKEN"] = originalValue;
      }
    }
  });
});
