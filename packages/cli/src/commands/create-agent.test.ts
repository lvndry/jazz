import type { AgentConfigService } from "@jazz/core/interfaces/agent-config";
import type { LLMService } from "@jazz/core/interfaces/llm";
import type { TerminalService } from "@jazz/core/interfaces/terminal";
import { LLMConfigurationError } from "@jazz/core/types/errors";
import type { LLMProvider } from "@jazz/core/types/llm";
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { promptForAgentInfo } from "./create-agent";

function terminal(options: {
  readonly ask: TerminalService["ask"];
  readonly search: TerminalService["search"];
  readonly select: TerminalService["select"];
  readonly error?: TerminalService["error"];
}): TerminalService {
  return {
    isInteractive: true,
    ask: options.ask,
    search: options.search,
    select: options.select,
    info: () => Effect.void,
    success: () => Effect.void,
    warn: () => Effect.void,
    error: options.error ?? (() => Effect.void),
    debug: () => Effect.void,
    log: () => Effect.void,
    heading: () => Effect.void,
    list: () => Effect.void,
    clear: () => Effect.void,
    user: () => Effect.void,
    setTitle: () => Effect.void,
    password: () => Effect.succeed(""),
    confirm: () => Effect.succeed(false),
    checkbox: () => Effect.succeed([]),
  } as TerminalService;
}

describe("promptForAgentInfo", () => {
  it("creates a llama.cpp agent around the live server model without a model picker", async () => {
    const searched: string[] = [];
    const asked: string[] = [];
    const saved: Array<{ key: string; value: unknown }> = [];
    const liveProvider: LLMProvider = {
      name: "llamacpp",
      defaultModel: "qwen3-32b",
      supportedModels: [
        {
          id: "qwen3-32b",
          supportsTools: false,
          isReasoningModel: false,
        },
      ],
      authenticate: () => Effect.void,
    };
    const llmService = {
      listProviders: () =>
        Effect.succeed([{ name: "llamacpp", displayName: "llama.cpp", configured: true }]),
      getProvider: () => Effect.succeed(liveProvider),
    } as unknown as LLMService;
    const configService = {
      appConfig: Effect.succeed({}),
      set: (key: string, value: unknown) => {
        saved.push({ key, value });
        return Effect.void;
      },
    } as unknown as AgentConfigService;

    const result = await promptForAgentInfo(
      ["default"],
      {},
      llmService,
      configService,
      new Map(),
      terminal({
        search: ((message) => {
          searched.push(message);
          return Effect.succeed("llamacpp");
        }) as TerminalService["search"],
        ask: (message) => {
          asked.push(message);
          if (message.includes("server URL")) return Effect.succeed("127.0.0.1:8000");
          if (message.includes("Name")) return Effect.succeed("vllm-agent");
          return Effect.succeed("");
        },
        select: (() => Effect.succeed("default")) as TerminalService["select"],
      }),
      new Set(),
    );

    expect(result).toMatchObject({
      llmProvider: "llamacpp",
      llmModel: "qwen3-32b",
      name: "vllm-agent",
      persona: "default",
    });
    expect(searched).toHaveLength(1);
    expect(searched[0]).toContain("Which LLM provider");
    expect(asked.some((message) => message.includes("Which model"))).toBe(false);
    expect(saved).toEqual([{ key: "llm.llamacpp.base_url", value: "http://127.0.0.1:8000/v1" }]);
  });

  it("re-asks for the server URL instead of aborting when llama.cpp is unreachable", async () => {
    const asked: string[] = [];
    const errors: string[] = [];
    const saved: Array<{ key: string; value: unknown }> = [];
    let appConfig: Record<string, unknown> = {};
    const serverUrls = ["127.0.0.1:8999", "127.0.0.1:8000"];
    const liveProvider: LLMProvider = {
      name: "llamacpp",
      defaultModel: "qwen3-32b",
      supportedModels: [{ id: "qwen3-32b", supportsTools: false, isReasoningModel: false }],
      authenticate: () => Effect.void,
    };
    let providerLookups = 0;
    const llmService = {
      listProviders: () =>
        Effect.succeed([{ name: "llamacpp", displayName: "llama.cpp", configured: true }]),
      getProvider: () => {
        providerLookups += 1;
        return providerLookups === 1
          ? Effect.fail(
              new LLMConfigurationError({
                provider: "llamacpp",
                message: "Cannot reach the llama.cpp server at http://127.0.0.1:8999/v1.",
              }),
            )
          : Effect.succeed(liveProvider);
      },
    } as unknown as LLMService;
    const configService = {
      get appConfig() {
        return Effect.succeed(appConfig);
      },
      set: (key: string, value: unknown) => {
        saved.push({ key, value });
        appConfig = { llm: { llamacpp: { base_url: value } } };
        return Effect.void;
      },
    } as unknown as AgentConfigService;

    const result = await promptForAgentInfo(
      ["default"],
      {},
      llmService,
      configService,
      new Map(),
      terminal({
        search: (() => Effect.succeed("llamacpp")) as TerminalService["search"],
        ask: (message) => {
          asked.push(message);
          if (message.includes("server URL")) {
            return Effect.succeed(serverUrls.shift() ?? "");
          }
          if (message.includes("Name")) {
            return Effect.succeed("local-agent");
          }
          return Effect.succeed("");
        },
        select: (() => Effect.succeed("default")) as TerminalService["select"],
        error: (message) => {
          errors.push(String(message));
          return Effect.void;
        },
      }),
      new Set(),
    );

    expect(result).toMatchObject({ llmProvider: "llamacpp", name: "local-agent" });
    expect(errors).toEqual(["Cannot reach the llama.cpp server at http://127.0.0.1:8999/v1."]);
    expect(asked.filter((message) => message.includes("server URL"))).toHaveLength(2);
    expect(saved.map((entry) => entry.value)).toEqual([
      "http://127.0.0.1:8999/v1",
      "http://127.0.0.1:8000/v1",
    ]);
  });
});
