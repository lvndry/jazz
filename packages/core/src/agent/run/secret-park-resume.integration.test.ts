/**
 * A run nobody can answer that stops for a secret: it parks with the prompt and name only, and a
 * secret typed later reaches the resumed run in memory, never the run record.
 */

import os from "node:os";
import { InMemoryRunStore } from "@jazz/adapters/storage/run-store";
import { describe, expect, it, mock } from "bun:test";
import { Effect, FileSystem, Layer, Stream } from "effect";
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
import { partialFake } from "@/core/test-support/fakes";
import type { Agent } from "@/core/types/agent";
import type { ChatCompletionOptions, ChatCompletionResponse } from "@/core/types/chat";
import type { ToolExecutionContext } from "@/core/types/tools";
import { resumeRun } from "./resume";
import { AgentRunner } from "../agent-runner";
import { ASK_USER_SECRET_TOOL_NAME, userInteractionTools } from "../tools/user-interaction";

const SECRET = "typed-after-the-park-77";
const AGENT: Agent = {
  id: "asker",
  name: "asker",
  config: {
    persona: "default",
    llm: { provider: "openai", model: "gpt-4" },
    tools: [ASK_USER_SECRET_TOOL_NAME],
  },
  createdAt: new Date("2026-09-01T00:00:00Z"),
  updatedAt: new Date("2026-09-01T00:00:00Z"),
};
const ASK_CALL = {
  id: "call_secret_1",
  type: "function" as const,
  function: {
    name: ASK_USER_SECRET_TOOL_NAME,
    arguments: JSON.stringify({ prompt: "Password for a.pdf", name: "pdf-password" }),
  },
};
const askUserSecret = userInteractionTools.find((tool) => tool.name === ASK_USER_SECRET_TOOL_NAME);

function makeLayers(store: InMemoryRunStore, requests: ChatCompletionOptions[]) {
  let completions = 0;
  const completion = (options: ChatCompletionOptions): ChatCompletionResponse => {
    requests.push(structuredClone(options));
    completions += 1;
    return completions === 1
      ? { id: "c1", model: "gpt-4", content: "", toolCalls: [ASK_CALL] }
      : { id: "c2", model: "gpt-4", content: "Done." };
  };
  const quiet = () => Effect.void;
  const logger = partialFake<LoggerService>({
    debug: quiet,
    info: quiet,
    warn: quiet,
    error: quiet,
    setLogGroup: quiet,
    clearLogGroup: quiet,
    pushLogGroup: quiet,
    popLogGroup: quiet,
    writeToFile: quiet,
    logToolCall: quiet,
  });
  const presentation = partialFake<PresentationService>({
    presentThinking: quiet,
    renderMarkdown: (content: string) => Effect.succeed(content),
    presentAgentResponse: quiet,
    presentCompletion: quiet,
    writeOutput: quiet,
    writeBlankLine: quiet,
    writeError: quiet,
    formatToolExecutionStart: () => Effect.succeed(""),
    formatToolExecutionComplete: () => Effect.succeed(""),
    formatToolResult: () => "",
    formatToolExecutionError: () => Effect.succeed(""),
    formatToolsDetected: () => Effect.succeed(""),
    signalToolExecutionStarted: quiet,
    canPromptForApproval: () => false,
    requestSecretInput: () => Effect.die("nobody is here to type it"),
  });
  const toolMeta = {
    name: ASK_USER_SECRET_TOOL_NAME,
    riskLevel: "read-only",
    hidden: false,
    longRunning: true,
  };
  const definition = {
    function: { name: ASK_USER_SECRET_TOOL_NAME, description: "ask", parameters: {} },
  };
  const registry = partialFake<ToolRegistry>({
    registerTool: mock(() => Effect.succeed(undefined)),
    registerForCategory: mock(() => mock(() => Effect.succeed(undefined))),
    listTools: () => Effect.succeed([ASK_USER_SECRET_TOOL_NAME]),
    listAllTools: () => Effect.succeed([ASK_USER_SECRET_TOOL_NAME]),
    getToolsInCategory: () => Effect.succeed([]),
    getTool: () => Effect.succeed(toolMeta),
    getToolDefinitions: () => Effect.succeed([definition]),
    getToolDefinitionsFor: () => Effect.succeed([definition]),
    getToolSummaries: () => Effect.succeed([]),
    partitionByTier: (names: readonly string[]) => Effect.succeed({ eager: names, deferred: [] }),
    executeTool: (_name: string, args: Record<string, unknown>, context: ToolExecutionContext) =>
      askUserSecret!.execute(args, context),
  });
  const llm = partialFake<LLMService>({
    getProvider: () =>
      Effect.succeed({
        name: "openai",
        supportedModels: [{ id: "gpt-4", supportsTools: true }],
        defaultModel: "gpt-4",
        authenticate: () => Effect.void,
      }),
    listProviders: () => Effect.succeed([]),
    createChatCompletion: (_provider: string, options: ChatCompletionOptions) =>
      Effect.sync(() => completion(options)),
    createStreamingChatCompletion: (_provider: string, options: ChatCompletionOptions) =>
      Effect.sync(() => {
        const response = completion(options);
        return { stream: Stream.empty, response: Effect.succeed(response), cancel: Effect.void };
      }),
  });
  return Layer.mergeAll(
    Layer.succeed(LoggerServiceTag, logger),
    Layer.succeed(PresentationServiceTag, presentation),
    Layer.succeed(ToolRegistryTag, registry),
    Layer.succeed(LLMServiceTag, llm),
    Layer.succeed(
      AgentServiceTag,
      partialFake<AgentService>({
        getAgent: () => Effect.succeed(AGENT),
        listAgents: () => Effect.succeed([AGENT]),
      }),
    ),
    Layer.succeed(RunStoreTag, store),
    Layer.succeed(
      SkillServiceTag,
      partialFake<SkillService>({
        listSkills: () => Effect.succeed([]),
      }),
    ),
    Layer.succeed(
      AgentConfigServiceTag,
      partialFake<AgentConfigService>({
        appConfig: Effect.succeed({
          output: { showMetrics: false, streaming: { enabled: false }, mode: "text" as const },
          llm: { openai: { api_key: "test-key" } },
        }),
        get: () => Effect.succeed(undefined),
        getOrElse: (_key: string, fallback: unknown) => Effect.succeed(fallback),
        getOrFail: () => Effect.succeed(undefined),
        has: () => Effect.succeed(false),
        set: () => Effect.void,
      }),
    ),
    Layer.succeed(
      PersonaServiceTag,
      partialFake<PersonaService>({
        getPersonaByIdentifier: () =>
          Effect.succeed({ name: "default", description: "test", systemPrompt: "You test." }),
      }),
    ),
    Layer.succeed(MCPServerManagerTag, partialFake<MCPServerManager>({})),
    Layer.succeed(TerminalServiceTag, partialFake<TerminalService>({})),
    Layer.succeed(FileSystem.FileSystem, partialFake<FileSystem.FileSystem>({})),
    Layer.succeed(
      FileSystemContextServiceTag,
      partialFake<FileSystemContextService>({
        getCwd: () => Effect.succeed(os.tmpdir()),
        setCwd: () => Effect.void,
      }),
    ),
  );
}

describe("a parked secret", () => {
  it("parks with the prompt only and resumes with a secret held in memory", async () => {
    const store = new InMemoryRunStore();
    const requests: ChatCompletionOptions[] = [];
    const layers = makeLayers(store, requests);

    const parkExit = await Effect.runPromiseExit(
      AgentRunner.run({
        agent: AGENT,
        userInput: "read a.pdf",
        conversationId: "conv-1",
        stream: false,
        parkWhenUnattended: true,
      }).pipe(Effect.provide(layers)) as Effect.Effect<unknown, unknown>,
    );
    expect(parkExit._tag).toBe("Failure");

    const parked = (await Effect.runPromise(store.list()))[0];
    if (parked?.state.kind !== "input-required") {
      throw new Error("expected a parked run");
    }
    expect(parked.state.pending).toEqual({
      kind: "secret",
      toolCallId: ASK_CALL.id,
      request: { prompt: "Password for a.pdf", name: "pdf-password" },
    });

    const resumeExit = await Effect.runPromiseExit(
      resumeRun({
        runId: parked.runId,
        outcome: { kind: "secret", value: { kind: "provided", value: SECRET } },
      }).pipe(Effect.provide(layers)) as Effect.Effect<unknown, unknown>,
    );
    expect(resumeExit._tag).toBe("Success");

    const finished = await Effect.runPromise(store.get(parked.runId));
    expect(finished?.state.kind).toBe("completed");
    expect(JSON.stringify(finished)).not.toContain(SECRET);
    const lastRequest = JSON.stringify(requests.at(-1)?.messages);
    expect(lastRequest).toContain("[redacted:pdf-password]");
    expect(lastRequest).not.toContain(SECRET);
  });
});
