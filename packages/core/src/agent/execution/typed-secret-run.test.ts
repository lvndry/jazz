import { FileSystem } from "@effect/platform";
import { afterEach, describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { z } from "zod";
import { closeUserSecretStore, openUserSecretStore } from "@/core/secrets/user-secrets";
import { SkillServiceTag } from "@/core/skills/skill-service";
import { executeWithoutStreaming } from "./batch-executor";
import { DEFAULT_MAX_ITERATIONS } from "../../constants/agent";
import { AgentConfigServiceTag } from "../../interfaces/agent-config";
import { FileSystemContextServiceTag } from "../../interfaces/fs";
import type { LLMService } from "../../interfaces/llm";
import { LLMServiceTag } from "../../interfaces/llm";
import { LoggerServiceTag, type LoggerService } from "../../interfaces/logger";
import { MCPServerManagerTag } from "../../interfaces/mcp-server";
import { PresentationServiceTag } from "../../interfaces/presentation";
import { TerminalServiceTag } from "../../interfaces/terminal";
import { ToolRegistryTag } from "../../interfaces/tool-registry";
import type { ChatCompletionOptions } from "../../types/chat";
import type { ChatCompletionResponse } from "../../types/chat";
import type { RecursiveRunner } from "../context/summarizer";
import { createAgentRunMetrics } from "../metrics/agent-run-metrics";
import { createSubagentSupervisor } from "../subagents/supervisor";
import { defineTool } from "../tools/base-tool";
import { createToolRegistryLayer } from "../tools/tool-registry";
import { userInteractionTools } from "../tools/user-interaction";
import { DEFAULT_DISPLAY_CONFIG } from "../types";
import type { AgentResponse, AgentRunContext, AgentRunnerOptions } from "../types";

const SECRET = "hunter2-but-longer";
const logged: string[] = [];
const record =
  (level: string) =>
  (message: string, metadata?: Record<string, unknown>): Effect.Effect<void> =>
    Effect.sync(() => void logged.push(JSON.stringify({ level, message, metadata })));
const logger: LoggerService = {
  debug: record("debug"),
  info: record("info"),
  warn: record("warn"),
  error: record("error"),
  writeToFile: () => Effect.void,
  logToolCall: (name, args) => Effect.sync(() => void logged.push(JSON.stringify({ name, args }))),
  setLogGroup: () => Effect.void,
  clearLogGroup: () => Effect.void,
  pushLogGroup: () => Effect.void,
  popLogGroup: () => Effect.void,
};

const completions: ChatCompletionResponse[] = [
  {
    id: "c1",
    model: "m",
    content: "",
    toolCalls: [
      {
        id: "call_ask",
        type: "function",
        function: {
          name: "ask_user_secret",
          arguments: JSON.stringify({ prompt: "Password for a.zip", name: "zip-password" }),
        },
      },
    ],
  },
  {
    id: "c2",
    model: "m",
    content: "",
    toolCalls: [
      {
        id: "call_unlock",
        type: "function",
        function: {
          name: "unlock_archive",
          arguments: JSON.stringify({ path: "a.zip", password: "[redacted:zip-password]" }),
        },
      },
    ],
  },
  { id: "c3", model: "m", content: "The archive is open." },
];

function scriptedLlm(requests: ChatCompletionOptions[]): LLMService {
  let call = 0;
  return {
    createStreamingChatCompletion: () => Effect.fail(new Error("streaming must not be used")),
    createChatCompletion: (_provider: string, options: ChatCompletionOptions) =>
      Effect.sync(() => {
        requests.push(structuredClone(options));
        const response = completions[call] ?? completions[completions.length - 1];
        call += 1;
        return response as ChatCompletionResponse;
      }),
    listProviders: () => Effect.succeed([]),
    getProvider: () => Effect.fail(new Error("not implemented")),
    supportsNativeWebSearch: () => Effect.succeed(false),
    resolveReasoningControl: () => Effect.succeed({ kind: "unknown" as const }),
  } as unknown as LLMService;
}

const received: string[] = [];
const unlockArchive = defineTool({
  name: "unlock_archive",
  description: "Open an encrypted archive.",
  disclosure: "private",
  userSecretArguments: ["password"],
  parameters: z.object({ path: z.string(), password: z.string() }),
  handler: (args: { path: string; password: string }) =>
    Effect.sync(() => {
      received.push(args.password);
      return { success: true, result: `opened ${args.path}; the password was ${args.password}` };
    }),
});

const presentation = {
  canPromptForApproval: () => true,
  requestSecretInput: () => Effect.succeed({ kind: "provided", value: SECRET }),
  signalToolExecutionStarted: () => Effect.void,
  createStreamingRenderer: () => Effect.succeed(null),
  presentThinking: () => Effect.void,
  presentCompletion: () => Effect.void,
  presentAgentResponse: () => Effect.void,
  presentWarning: () => Effect.void,
  presentStatus: () => Effect.void,
  renderMarkdown: (text: string) => Effect.succeed(text),
  writeOutput: () => Effect.void,
  writeBlankLine: () => Effect.void,
  writeError: () => Effect.void,
  formatToolArguments: () => "",
  formatToolResult: () => "",
  formatToolExecutionStart: () => Effect.succeed(""),
  formatToolExecutionComplete: () => Effect.succeed(""),
  formatToolExecutionError: () => Effect.succeed(""),
  formatToolsDetected: () => Effect.succeed(""),
} as never;

const runRecursive: RecursiveRunner = () =>
  Effect.succeed({ content: "recursive", conversationId: "id" } as AgentResponse);

const stores: ReturnType<typeof openUserSecretStore>[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) {
    closeUserSecretStore(store);
  }
});

function runContext(): AgentRunContext {
  const agent = {
    id: "agent-1",
    name: "test-agent",
    config: {
      persona: "default",
      llm: { provider: "ollama", model: "m" },
      reasoningEffort: "disable",
    },
  } as never;
  const store = openUserSecretStore();
  stores.push(store);
  return {
    actualConversationId: "conv-1",
    context: {
      agentId: "agent-1",
      conversationId: "conv-1",
      userSecrets: store,
      effectiveToolNames: new Set(["ask_user_secret", "unlock_archive"]),
    },
    tools: [],
    messages: [{ role: "user", content: "open a.zip" }],
    runMetrics: createAgentRunMetrics({
      agent,
      conversationId: "conv-1",
      provider: "ollama",
      model: "m",
      reasoningEffort: "disable",
    }),
    provider: "ollama",
    model: "m",
    agent,
    expandedToolNames: ["ask_user_secret", "unlock_archive"],
    connectedMCPServers: [],
    subagents: Effect.runSync(createSubagentSupervisor()),
    knownSkills: [],
    maxRetries: 0,
    maxIterations: DEFAULT_MAX_ITERATIONS,
    maxCostUSD: undefined,
    maxTokens: undefined,
    maxDurationMs: undefined,
    deadline: undefined,
  };
}

describe("a run that asks for a secret", () => {
  it("uses the value in the tool and keeps it out of the transcript, the provider and the logs", async () => {
    const requests: ChatCompletionOptions[] = [];
    const layer = Layer.mergeAll(
      createToolRegistryLayer(),
      Layer.succeed(LoggerServiceTag, logger),
      Layer.succeed(PresentationServiceTag, presentation),
      Layer.succeed(LLMServiceTag, scriptedLlm(requests)),
      Layer.succeed(MCPServerManagerTag, {} as never),
      Layer.succeed(AgentConfigServiceTag, { appConfig: Effect.succeed({}) } as never),
      Layer.succeed(FileSystem.FileSystem, {} as never),
      Layer.succeed(TerminalServiceTag, {} as never),
      Layer.succeed(FileSystemContextServiceTag, {} as never),
      Layer.succeed(SkillServiceTag, { listSkills: () => Effect.succeed([]) } as never),
    );
    const options: AgentRunnerOptions = {
      conversationId: "conv-1",
      agent: runContext().agent,
      userInput: "open a.zip",
    };

    const response = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ToolRegistryTag;
        for (const tool of [...userInteractionTools, unlockArchive]) {
          yield* registry.registerTool(tool);
        }
        return yield* executeWithoutStreaming(
          options,
          runContext(),
          DEFAULT_DISPLAY_CONFIG,
          false,
          runRecursive,
        );
      }).pipe(Effect.provide(layer)) as Effect.Effect<AgentResponse, never, never>,
    );

    expect(received).toEqual([SECRET]);
    expect(response.content).toBe("The archive is open.");
    const transcript = JSON.stringify(response.messages);
    expect(transcript).toContain("[redacted:zip-password]");
    expect(transcript).not.toContain(SECRET);
    expect(requests.length).toBe(3);
    expect(JSON.stringify(requests.map((request) => request.messages))).not.toContain(SECRET);
    expect(logged.join("\n")).not.toContain(SECRET);
  });
});
