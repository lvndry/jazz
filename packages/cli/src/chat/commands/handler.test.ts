import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { createFileSystemContextServiceLayer } from "@jazz/adapters/fs";
import { saveConversation } from "@jazz/adapters/history/conversation-history-service";
import { AgentRunner } from "@jazz/core/agent/agent-runner";
import { AgentConfigServiceTag, type AgentConfigService } from "@jazz/core/interfaces/agent-config";
import { JazzStateServiceTag, type JazzStateService } from "@jazz/core/interfaces/jazz-state";
import { type LLMService, LLMServiceTag } from "@jazz/core/interfaces/llm";
import { LoggerServiceTag, type LoggerService } from "@jazz/core/interfaces/logger";
import {
  PluginRuntimeServiceTag,
  type PluginRuntimeService,
} from "@jazz/core/interfaces/plugin-runtime";
import { TerminalServiceTag, type TerminalService } from "@jazz/core/interfaces/terminal";
import { ToolRegistryTag, type ToolRegistry } from "@jazz/core/interfaces/tool-registry";
import type { Agent } from "@jazz/core/types/agent";
import type { ChatMessage } from "@jazz/core/types/message";
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { Effect, Layer } from "effect";
import { handleSpecialCommand } from "./handler";
import type { CommandContext, CommandResult } from "./types";

let tmpDir = "";

mock.module("@jazz/core/utils/paths", () => ({
  getHistoryDirectory: () => tmpDir,
  getUserDataDirectory: () => tmpDir,
  getGlobalUserDataDirectory: () => tmpDir,
  getPackageRootDirectory: () => null,
  getBuiltinSkillsDirectory: () => null,
  getGlobalSkillsDirectory: () => tmpDir,
  getAgentsSkillsDirectory: () => tmpDir,
  getBuiltinPersonasDirectory: () => null,
  getGlobalWorkflowsDirectory: () => tmpDir,
}));

const TEST_AGENT_ID = "test-agent-resume";

const testAgent: Agent = {
  id: TEST_AGENT_ID,
  name: "Test Agent",
  description: "Test agent for resume command tests",
  config: {
    persona: "default",
    llmProvider: "openai",
    llmModel: "gpt-4",
    tools: [],
  },
  createdAt: new Date(),
  updatedAt: new Date(),
};

const testRecord = {
  conversationId: "conv-to-resume",
  title: "A past conversation",
  agentId: TEST_AGENT_ID,
  startedAt: new Date(Date.now() - 3600_000).toISOString(),
  endedAt: new Date(Date.now() - 3000_000).toISOString(),
  messageCount: 2,
  messages: [
    { role: "user" as const, content: "Hello" },
    { role: "assistant" as const, content: "Hi there" },
  ] as ChatMessage[],
};

function runEffect<A>(eff: Effect.Effect<A, unknown, FileSystem.FileSystem>) {
  return Effect.runPromise(eff.pipe(Effect.provide(NodeFileSystem.layer)));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-resume-handler-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("handleSpecialCommand resume", () => {
  test("sets resetStartedAt on the result when a conversation is successfully resumed", async () => {
    await runEffect(saveConversation(testRecord, tmpDir));

    const mockTerminal: Partial<TerminalService> = {
      search: mock(() => Effect.succeed("conv-to-resume")) as TerminalService["search"],
      success: mock(() => Effect.void),
      log: mock(() => Effect.succeed(undefined)),
      info: mock(() => Effect.void),
    };

    const terminalLayer = Layer.succeed(
      TerminalServiceTag,
      mockTerminal as unknown as TerminalService,
    );
    const jazzStateLayer = Layer.succeed(JazzStateServiceTag, {
      get: () => Effect.succeed(undefined),
      set: () => Effect.void,
      load: () => Effect.succeed({}),
      persist: () => Effect.void,
    } as unknown as JazzStateService);
    const testLayer = Layer.mergeAll(terminalLayer, jazzStateLayer, NodeFileSystem.layer);

    const context: CommandContext = {
      agent: testAgent,
      conversationHistory: [],
      conversationId: "test-session",
      sessionUsage: { promptTokens: 0, completionTokens: 0 },
      sessionTurnCount: 0,
      sessionLimits: {},
      sessionStartedAt: new Date(Date.now() - 1800_000),
    };

    const result = await Effect.runPromise(
      handleSpecialCommand({ type: "resume", args: [] }, context).pipe(
        Effect.provide(testLayer),
        // The resume path only touches the provided services; the rest of the
        // handler's requirements are deliberately left unsatisfied.
      ) as Effect.Effect<CommandResult, unknown, never>,
    );

    expect(result.resetStartedAt).toBe(true);
    expect(result.newHistory?.map((message) => message.content)).toEqual([
      expect.stringContaining("Resuming conversation from"),
      "Hello",
      "Hi there",
    ]);
  });

  test("does not replace history when this agent has no past conversations", async () => {
    const info = mock(() => Effect.void);
    const mockTerminal: Partial<TerminalService> = {
      info,
      log: mock(() => Effect.succeed(undefined)),
    };

    const terminalLayer = Layer.succeed(
      TerminalServiceTag,
      mockTerminal as unknown as TerminalService,
    );
    const jazzStateLayer = Layer.succeed(JazzStateServiceTag, {
      get: () => Effect.succeed(undefined),
      set: () => Effect.void,
      load: () => Effect.succeed({}),
      persist: () => Effect.void,
    } as unknown as JazzStateService);
    const testLayer = Layer.mergeAll(terminalLayer, jazzStateLayer, NodeFileSystem.layer);

    const context: CommandContext = {
      agent: testAgent,
      conversationHistory: [{ role: "user", content: "still on screen" }],
      conversationId: "test-session",
      sessionUsage: { promptTokens: 0, completionTokens: 0 },
      sessionTurnCount: 0,
      sessionLimits: {},
      sessionStartedAt: new Date(Date.now() - 1800_000),
    };

    const result = await Effect.runPromise(
      handleSpecialCommand({ type: "resume", args: [] }, context).pipe(
        Effect.provide(testLayer),
        // The resume path only touches the provided services; the rest of the
        // handler's requirements are deliberately left unsatisfied.
      ) as Effect.Effect<CommandResult, unknown, never>,
    );

    expect(result).toEqual({ shouldContinue: true });
    expect(info).toHaveBeenCalled();
  });
});

describe("handleSpecialCommand shell escape", () => {
  test("executes the command and returns its bounded result as agent context", async () => {
    const output: string[] = [];
    const mockTerminal: Partial<TerminalService> = {
      log: mock((message: string) => {
        output.push(message);
        return Effect.succeed(undefined);
      }) as TerminalService["log"],
      error: mock(() => Effect.void),
    };
    const mockLogger: Partial<LoggerService> = {
      info: mock(() => Effect.void),
    };
    const fsContextLayer = createFileSystemContextServiceLayer().pipe(
      Layer.provide(NodeFileSystem.layer),
    );
    const layers = Layer.mergeAll(
      Layer.succeed(TerminalServiceTag, mockTerminal as TerminalService),
      Layer.succeed(LoggerServiceTag, mockLogger as LoggerService),
      fsContextLayer,
    );

    const result = await Effect.runPromise(
      handleSpecialCommand(
        { type: "shell", args: ["printf 'alpha'"] },
        {
          agent: testAgent,
          conversationHistory: [],
          conversationId: "test-session",
          sessionUsage: { promptTokens: 0, completionTokens: 0 },
          sessionTurnCount: 0,
          sessionLimits: {},
          sessionStartedAt: new Date(),
        },
      ).pipe(Effect.provide(layers)) as Effect.Effect<CommandResult, unknown, never>,
    );

    expect(output).toEqual(["alpha"]);
    expect(result.messageForAgent).toContain("Exit code: 0");
    expect(result.messageForAgent).toContain("alpha");
  });

  test("does not execute a denylisted command", async () => {
    const error = mock(() => Effect.void);
    const mockTerminal: Partial<TerminalService> = { error };
    const fsContextLayer = createFileSystemContextServiceLayer().pipe(
      Layer.provide(NodeFileSystem.layer),
    );
    const mockLogger: Partial<LoggerService> = { info: () => Effect.void };
    const layers = Layer.mergeAll(
      Layer.succeed(TerminalServiceTag, mockTerminal as TerminalService),
      Layer.succeed(LoggerServiceTag, mockLogger as LoggerService),
      fsContextLayer,
    );

    const result = await Effect.runPromise(
      handleSpecialCommand(
        { type: "shell", args: ["rm -rf /"] },
        {
          agent: testAgent,
          conversationHistory: [],
          conversationId: "test-session",
          sessionUsage: { promptTokens: 0, completionTokens: 0 },
          sessionTurnCount: 0,
          sessionLimits: {},
          sessionStartedAt: new Date(),
        },
      ).pipe(Effect.provide(layers)) as Effect.Effect<CommandResult, unknown, never>,
    );

    expect(error).toHaveBeenCalled();
    expect(result.messageForAgent).toContain("blocked");
  });
});

describe("handleSpecialCommand /reasoning", () => {
  const baseContext: CommandContext = {
    agent: { ...testAgent, config: { ...testAgent.config, reasoningEffort: "disable" } },
    conversationHistory: [],
    conversationId: "test-session",
    sessionUsage: { promptTokens: 0, completionTokens: 0 },
    sessionTurnCount: 0,
    sessionLimits: {},
    sessionStartedAt: new Date(),
  };

  test("sets reasoning effort for this session without persisting it", async () => {
    const success = mock(() => Effect.void);
    const mockTerminal: Partial<TerminalService> = {
      isInteractive: false,
      select: mock(() => Effect.succeed(undefined)) as TerminalService["select"],
      success,
      log: mock(() => Effect.succeed(undefined)),
      error: mock(() => Effect.void),
      info: mock(() => Effect.void),
    };
    const terminalLayer = Layer.succeed(
      TerminalServiceTag,
      mockTerminal as unknown as TerminalService,
    );

    const result = await Effect.runPromise(
      handleSpecialCommand({ type: "reasoning", args: ["high"] }, baseContext).pipe(
        Effect.provide(terminalLayer),
      ) as Effect.Effect<CommandResult, unknown, never>,
    );

    expect(result.newAgent?.config.reasoningEffort).toBe("high");
    // The change is session-scoped: the original agent object is untouched.
    expect(baseContext.agent.config.reasoningEffort).toBe("disable");
    expect(success).toHaveBeenCalled();
  });

  test("rejects an invalid level and leaves the agent unchanged", async () => {
    const error = mock(() => Effect.void);
    const mockTerminal: Partial<TerminalService> = {
      isInteractive: false,
      select: mock(() => Effect.succeed(undefined)) as TerminalService["select"],
      log: mock(() => Effect.succeed(undefined)),
      error,
      info: mock(() => Effect.void),
    };
    const terminalLayer = Layer.succeed(
      TerminalServiceTag,
      mockTerminal as unknown as TerminalService,
    );

    const result = await Effect.runPromise(
      handleSpecialCommand({ type: "reasoning", args: ["bogus"] }, baseContext).pipe(
        Effect.provide(terminalLayer),
      ) as Effect.Effect<CommandResult, unknown, never>,
    );

    expect(result.newAgent).toBeUndefined();
    expect(error).toHaveBeenCalled();
  });

  test("opens the picker in interactive mode and applies the chosen level", async () => {
    const mockTerminal: Partial<TerminalService> = {
      isInteractive: true,
      select: mock(() => Effect.succeed("medium")) as unknown as TerminalService["select"],
      success: mock(() => Effect.void),
      log: mock(() => Effect.succeed(undefined)),
      error: mock(() => Effect.void),
      info: mock(() => Effect.void),
    };
    const terminalLayer = Layer.succeed(
      TerminalServiceTag,
      mockTerminal as unknown as TerminalService,
    );

    const result = await Effect.runPromise(
      handleSpecialCommand({ type: "reasoning", args: [] }, baseContext).pipe(
        Effect.provide(terminalLayer),
      ) as Effect.Effect<CommandResult, unknown, never>,
    );

    expect(result.newAgent?.config.reasoningEffort).toBe("medium");
  });
});

describe("handleSpecialCommand /compact", () => {
  const history: ChatMessage[] = [
    { role: "system", content: "system" },
    { role: "user", content: "first ask" },
    { role: "assistant", content: "first answer" },
    { role: "user", content: "second ask" },
    { role: "assistant", content: "second answer" },
  ];

  const context: CommandContext = {
    agent: testAgent,
    conversationHistory: history,
    conversationId: "conv-compact",
    sessionUsage: { promptTokens: 0, completionTokens: 0 },
    sessionTurnCount: 0,
    sessionLimits: {},
    sessionStartedAt: new Date(),
  };

  function runCompact(terminal: Partial<TerminalService> = {}): Promise<CommandResult> {
    const mockTerminal: Partial<TerminalService> = {
      info: mock(() => Effect.void),
      success: mock(() => Effect.void),
      warn: mock(() => Effect.void),
      error: mock(() => Effect.void),
      log: mock(() => Effect.succeed(undefined)),
      ...terminal,
    };
    const terminalLayer = Layer.succeed(
      TerminalServiceTag,
      mockTerminal as unknown as TerminalService,
    );
    return Effect.runPromise(
      handleSpecialCommand({ type: "compact", args: [] }, context).pipe(
        Effect.provide(terminalLayer),
      ) as Effect.Effect<CommandResult, unknown, never>,
    );
  }

  test("replaces the history with the compacted one, recent messages included", async () => {
    const compacted: ChatMessage[] = [
      { role: "system", content: "system" },
      { role: "assistant", content: "summary of the first exchange", kind: "summary" },
      { role: "user", content: "Continue the task.", kind: "continuation" },
      { role: "user", content: "second ask" },
      { role: "assistant", content: "second answer" },
    ];
    let received: { messages: readonly ChatMessage[]; conversationId: string } | undefined;
    const spy = spyOn(AgentRunner, "compactHistory").mockImplementation(
      (messages, _agent, conversationId) => {
        received = { messages, conversationId };
        return Effect.succeed({
          messages: compacted,
          tokensBefore: 900,
          tokensAfter: 400,
        }) as unknown as ReturnType<typeof AgentRunner.compactHistory>;
      },
    );

    try {
      const result = await runCompact();

      expect(received?.conversationId).toBe("conv-compact");
      expect(received?.messages).toEqual(history);
      expect(result.newHistory).toEqual(compacted);
    } finally {
      spy.mockRestore();
    }
  });

  test("leaves the history alone when nothing is old enough to compact", async () => {
    const spy = spyOn(AgentRunner, "compactHistory").mockImplementation(
      () => Effect.succeed(undefined) as unknown as ReturnType<typeof AgentRunner.compactHistory>,
    );

    try {
      const result = await runCompact();
      expect(result.newHistory).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  test("reports a failed compaction and keeps the history", async () => {
    const error = mock(() => Effect.void);
    const spy = spyOn(AgentRunner, "compactHistory").mockImplementation(
      () =>
        Effect.fail(new Error("provider down")) as unknown as ReturnType<
          typeof AgentRunner.compactHistory
        >,
    );

    try {
      const result = await runCompact({ error });
      expect(result.newHistory).toBeUndefined();
      expect(error).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("accounts against the llama.cpp served window, not the advertised fallback", async () => {
    const llamaAgent: Agent = {
      ...testAgent,
      config: { ...testAgent.config, llmProvider: "llamacpp", llmModel: "local-model" },
    };
    const llamaContext: CommandContext = { ...context, agent: llamaAgent };

    let receivedContextWindow: number | undefined;
    const spy = spyOn(AgentRunner, "compactHistory").mockImplementation(
      (_messages, _agent, _conversationId, contextWindowTokens) => {
        receivedContextWindow = contextWindowTokens;
        return Effect.succeed(undefined) as unknown as ReturnType<
          typeof AgentRunner.compactHistory
        >;
      },
    );

    const mockLLMService: Partial<LLMService> = {
      resolveLocalProviderBaseUrl: () => "http://localhost:8080",
      fetchLlamaCppServerModel: () => Effect.succeed({ contextWindow: 8000 }),
    };
    const mockAgentConfigService: Partial<AgentConfigService> = {
      appConfig: Effect.succeed({}) as AgentConfigService["appConfig"],
    };
    const mockTerminal: Partial<TerminalService> = {
      info: mock(() => Effect.void),
      success: mock(() => Effect.void),
      warn: mock(() => Effect.void),
      error: mock(() => Effect.void),
      log: mock(() => Effect.succeed(undefined)),
    };
    const layers = Layer.mergeAll(
      Layer.succeed(TerminalServiceTag, mockTerminal as unknown as TerminalService),
      Layer.succeed(LLMServiceTag, mockLLMService as unknown as LLMService),
      Layer.succeed(AgentConfigServiceTag, mockAgentConfigService as unknown as AgentConfigService),
    );

    try {
      await Effect.runPromise(
        handleSpecialCommand({ type: "compact", args: [] }, llamaContext).pipe(
          Effect.provide(layers),
        ) as Effect.Effect<CommandResult, unknown, never>,
      );

      expect(receivedContextWindow).toBe(8000);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("handleSpecialCommand /tools", () => {
  test("includes builtin categories not present in the agent's own config.tools", async () => {
    const logged: string[] = [];
    const mockTerminal: Partial<TerminalService> = {
      log: mock((message: string) => {
        logged.push(message);
        return Effect.succeed(undefined);
      }) as TerminalService["log"],
      warn: mock(() => Effect.void),
    };

    // An agent whose config only ever selected file_management/http/shell_commands —
    // no context/search_tools/todo/etc were ever explicitly picked.
    const agentToolsByCategory: Record<string, readonly string[]> = {
      "File Management": ["ls", "read_file"],
      HTTP: ["http_request"],
      "Shell Commands": ["execute_command"],
      Context: ["context_info", "get_time"],
      "Tool Search": ["search_tools"],
    };

    const mockToolRegistry: Partial<ToolRegistry> = {
      listToolsByCategory: () => Effect.succeed(agentToolsByCategory),
      getToolsInCategory: (categoryId: string) =>
        Effect.succeed(
          categoryId === "context"
            ? ["context_info", "get_time"]
            : categoryId === "search_tools"
              ? ["search_tools"]
              : [],
        ),
    };

    const mockAgentConfigService: Partial<AgentConfigService> = {
      appConfig: Effect.succeed({}) as AgentConfigService["appConfig"],
    };
    const mockLLMService: Partial<LLMService> = {
      supportsNativeWebSearch: () => Effect.succeed(false),
    };

    const layers = Layer.mergeAll(
      Layer.succeed(TerminalServiceTag, mockTerminal as unknown as TerminalService),
      Layer.succeed(ToolRegistryTag, mockToolRegistry as unknown as ToolRegistry),
      Layer.succeed(AgentConfigServiceTag, mockAgentConfigService as unknown as AgentConfigService),
      Layer.succeed(LLMServiceTag, mockLLMService as unknown as LLMService),
      // PersonaServiceTag deliberately not provided: Effect.serviceOption resolves to
      // None, matching a persona/agent with no explicit toolProfile.
    );

    const context: CommandContext = {
      agent: { ...testAgent, config: { ...testAgent.config, tools: ["http_request"] } },
      conversationHistory: [],
      conversationId: "test-session",
      sessionUsage: { promptTokens: 0, completionTokens: 0 },
      sessionTurnCount: 0,
      sessionLimits: {},
      sessionStartedAt: new Date(),
    };

    await Effect.runPromise(
      handleSpecialCommand({ type: "tools", args: [] }, context).pipe(
        Effect.provide(layers),
      ) as Effect.Effect<CommandResult, unknown, never>,
    );

    const output = logged.join("\n");
    expect(output).toContain("http_request");
    // Builtin categories, auto-injected at runtime, must show even though they were
    // never in agent.config.tools.
    expect(output).toContain("context_info");
    expect(output).toContain("search_tools");
  });
});

describe("handleSpecialCommand /agents", () => {
  test("delegates to the /switch picker in interactive mode", async () => {
    const mockTerminal: Partial<TerminalService> = {
      isInteractive: true,
      search: mock(() => Effect.succeed("other-agent-id")) as unknown as TerminalService["search"],
      success: mock(() => Effect.void),
      log: mock(() => Effect.succeed(undefined)),
      error: mock(() => Effect.void),
      info: mock(() => Effect.void),
      warn: mock(() => Effect.void),
    };
    const agentService = {
      listAgents: () =>
        Effect.succeed([
          testAgent,
          {
            ...testAgent,
            id: "other-agent-id",
            name: "Other",
            config: { ...testAgent.config, reasoningEffort: "disable" },
          },
        ]),
      getAgent: () =>
        Effect.succeed({
          ...testAgent,
          id: "other-agent-id",
          name: "Other",
          config: { ...testAgent.config, reasoningEffort: "disable" },
        }),
    } as unknown as import("@jazz/core/interfaces/agent-service").AgentService;
    const agentServiceTag = (await import("@jazz/core/interfaces/agent-service")).AgentServiceTag;
    const layers = Layer.mergeAll(
      Layer.succeed(TerminalServiceTag, mockTerminal as unknown as TerminalService),
      Layer.succeed(agentServiceTag, agentService),
    );

    const context: CommandContext = {
      agent: testAgent,
      conversationHistory: [],
      conversationId: "test-session",
      sessionUsage: { promptTokens: 0, completionTokens: 0 },
      sessionTurnCount: 0,
      sessionLimits: {},
      sessionStartedAt: new Date(),
      lastUsedAgentId: null,
    };

    const result = await Effect.runPromise(
      handleSpecialCommand({ type: "agents", args: [] }, context).pipe(
        Effect.provide(layers),
      ) as Effect.Effect<CommandResult, unknown, never>,
    );

    expect(result.newAgent?.id).toBe("other-agent-id");
  });
});

describe("handleSpecialCommand /peers", () => {
  test("lists configured peers with what they may learn and whether they can be asked", async () => {
    const logged: string[] = [];
    const mockTerminal: Partial<TerminalService> = {
      log: mock((message: string) => {
        logged.push(message);
        return Effect.succeed(undefined);
      }) as TerminalService["log"],
      warn: mock(() => Effect.void),
      info: mock(() => Effect.void),
    };

    const mockAgentConfigService: Partial<AgentConfigService> = {
      appConfig: Effect.succeed({
        peers: [
          { name: "bob", url: "http://100.101.102.103:4747/peer/ask", disclosure: "internal" },
          { name: "alice", disclosure: "public" },
          { name: "carol", url: "http://100.101.102.104:4747/peer/ask" },
        ],
      }) as unknown as AgentConfigService["appConfig"],
    };

    const layers = Layer.mergeAll(
      Layer.succeed(TerminalServiceTag, mockTerminal as unknown as TerminalService),
      Layer.succeed(AgentConfigServiceTag, mockAgentConfigService as unknown as AgentConfigService),
    );

    const context: CommandContext = {
      agent: testAgent,
      conversationHistory: [],
      conversationId: "test-session",
      sessionUsage: { promptTokens: 0, completionTokens: 0 },
      sessionTurnCount: 0,
      sessionLimits: {},
      sessionStartedAt: new Date(),
    };

    await Effect.runPromise(
      handleSpecialCommand({ type: "peers", args: [] }, context).pipe(
        Effect.provide(layers),
      ) as Effect.Effect<CommandResult, unknown, never>,
    );

    const output = logged.join("\n");
    expect(output).toContain("bob");
    expect(output).toContain("http://100.101.102.103:4747/peer/ask");
    expect(output).toContain("alice");
    // alice has no url — shown as an explicit placeholder, not omitted.
    expect(output).toContain("none — cannot be asked");
    // carol has no disclosure — still shown, via describeTier's own "none" default.
    expect(output.slice(output.indexOf("carol"))).toContain("They may learn");
  });

  test("tells you how to add one when none are configured", async () => {
    const infoMessages: string[] = [];
    const mockTerminal: Partial<TerminalService> = {
      log: mock(() => Effect.succeed(undefined)),
      warn: mock(() => Effect.void),
      info: mock((message: string) => {
        infoMessages.push(message);
        return Effect.void;
      }) as TerminalService["info"],
    };

    const mockAgentConfigService: Partial<AgentConfigService> = {
      appConfig: Effect.succeed({}) as AgentConfigService["appConfig"],
    };

    const layers = Layer.mergeAll(
      Layer.succeed(TerminalServiceTag, mockTerminal as unknown as TerminalService),
      Layer.succeed(AgentConfigServiceTag, mockAgentConfigService as unknown as AgentConfigService),
    );

    const context: CommandContext = {
      agent: testAgent,
      conversationHistory: [],
      conversationId: "test-session",
      sessionUsage: { promptTokens: 0, completionTokens: 0 },
      sessionTurnCount: 0,
      sessionLimits: {},
      sessionStartedAt: new Date(),
    };

    await Effect.runPromise(
      handleSpecialCommand({ type: "peers", args: [] }, context).pipe(
        Effect.provide(layers),
      ) as Effect.Effect<CommandResult, unknown, never>,
    );

    expect(infoMessages.join("\n")).toContain("jazz peers invite");
  });
});

describe("handleSpecialCommand /runPluginCommand", () => {
  const context: CommandContext = {
    agent: testAgent,
    conversationHistory: [],
    conversationId: "test-session",
    sessionUsage: { promptTokens: 0, completionTokens: 0 },
    sessionTurnCount: 0,
    sessionLimits: {},
    sessionStartedAt: new Date(),
  };

  const terminalLayer = Layer.succeed(TerminalServiceTag, {
    info: () => Effect.void,
    success: () => Effect.void,
    warn: () => Effect.void,
    error: () => Effect.void,
    log: () => Effect.succeed(undefined),
  } as unknown as TerminalService);

  function runtimeLayer(
    runAgentCommand: PluginRuntimeService["runAgentCommand"],
  ): Layer.Layer<PluginRuntimeService | TerminalService> {
    return Layer.merge(
      terminalLayer,
      Layer.succeed(PluginRuntimeServiceTag, {
        openSession: () => Effect.die("unused"),
        listAgentTools: () => Effect.succeed([]),
        runAgentTool: () => Effect.succeed({ content: "" }),
        listAgentCommands: () => Effect.succeed([]),
        runAgentCommand,
        listAllPersonas: () => Effect.succeed([]),
      }),
    );
  }

  test("sends the plugin command's message to the agent", async () => {
    let received: { agentId: string; name: string; args: readonly string[] } | undefined;
    const layer = runtimeLayer((agentId, name, args) => {
      received = { agentId, name, args };
      return Effect.succeed({ message: `Greet ${args.join(" ")} warmly.` });
    });
    const result = await Effect.runPromise(
      handleSpecialCommand({ type: "runPluginCommand", args: ["greet", "Ada"] }, context).pipe(
        Effect.provide(layer),
      ) as Effect.Effect<CommandResult, unknown, never>,
    );
    expect(received).toEqual({ agentId: testAgent.id, name: "greet", args: ["Ada"] });
    expect(result.resendMessage).toBe("Greet Ada warmly.");
  });

  test("is a quiet no-op when the command returns no message", async () => {
    const layer = runtimeLayer(() => Effect.succeed({}));
    const result = await Effect.runPromise(
      handleSpecialCommand({ type: "runPluginCommand", args: ["greet"] }, context).pipe(
        Effect.provide(layer),
      ) as Effect.Effect<CommandResult, unknown, never>,
    );
    expect(result).toEqual({ shouldContinue: true });
  });

  test("is a quiet no-op when no plugin runtime is available", async () => {
    const result = await Effect.runPromise(
      handleSpecialCommand({ type: "runPluginCommand", args: ["greet"] }, context).pipe(
        Effect.provide(terminalLayer),
      ) as Effect.Effect<CommandResult, unknown, never>,
    );
    expect(result).toEqual({ shouldContinue: true });
  });
});
