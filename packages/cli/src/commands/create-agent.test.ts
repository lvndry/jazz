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
  readonly warn?: TerminalService["warn"];
}): TerminalService {
  return {
    isInteractive: true,
    ask: options.ask,
    search: options.search,
    select: options.select,
    info: () => Effect.void,
    success: () => Effect.void,
    warn: options.warn ?? (() => Effect.void),
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
  it("selects a sole vLLM model without asking the user to pick it", async () => {
    const searched: string[] = [];
    const provider: LLMProvider = {
      name: "vllm",
      defaultModel: "org/only",
      supportedModels: [{ id: "org/only", supportsTools: true, isReasoningModel: false }],
      authenticate: () => Effect.void,
    };
    const result = await promptForAgentInfo(
      ["default"],
      {},
      {
        listProviders: () =>
          Effect.succeed([{ name: "vllm", displayName: "vLLM", configured: true }]),
        getProvider: () => Effect.succeed(provider),
      } as unknown as LLMService,
      {
        appConfig: Effect.succeed({}),
        set: () => Effect.void,
      } as unknown as AgentConfigService,
      new Map(),
      terminal({
        search: ((message) => {
          searched.push(message);
          return Effect.succeed("vllm");
        }) as TerminalService["search"],
        ask: (message) => Effect.succeed(message.includes("Name") ? "vllm-agent" : ""),
        select: (() => Effect.succeed("default")) as TerminalService["select"],
      }),
      new Set(),
    );

    expect(result).toMatchObject({ llmProvider: "vllm", llmModel: "org/only" });
    expect(searched).toHaveLength(1);
  });

  it("lets the user choose a vLLM model instead of using the server's first model", async () => {
    const searched: string[] = [];
    const saved: Array<{ key: string; value: unknown }> = [];
    const provider: LLMProvider = {
      name: "vllm",
      defaultModel: "org/first",
      supportedModels: [
        { id: "org/first", supportsTools: false, isReasoningModel: false },
        { id: "org/second", supportsTools: false, isReasoningModel: false },
      ],
      authenticate: () => Effect.void,
    };
    const llmService = {
      listProviders: () =>
        Effect.succeed([{ name: "vllm", displayName: "vLLM", configured: true }]),
      getProvider: () => Effect.succeed(provider),
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
          return Effect.succeed(message.includes("Which LLM provider") ? "vllm" : "org/second");
        }) as TerminalService["search"],
        ask: (message) => Effect.succeed(message.includes("Name") ? "vllm-agent" : ""),
        select: (() => Effect.succeed("default")) as TerminalService["select"],
      }),
      new Set(),
    );

    expect(result).toMatchObject({ llmProvider: "vllm", llmModel: "org/second" });
    expect(searched).toHaveLength(2);
    expect(saved).toEqual([{ key: "llm.vllm.base_url", value: "http://127.0.0.1:8000/v1" }]);
  });

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

  it("asks for an API key, not the URL, when the llama.cpp server rejects the request", async () => {
    const asked: string[] = [];
    const warnings: string[] = [];
    const saved: Array<{ key: string; value: unknown }> = [];
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
                message:
                  "The llama.cpp server at http://127.0.0.1:8090 rejected the request (401).",
                reason: "unauthorized",
              }),
            )
          : Effect.succeed(liveProvider);
      },
    } as unknown as LLMService;
    const configService = {
      appConfig: Effect.succeed({ llm: { llamacpp: { base_url: "http://127.0.0.1:8090/v1" } } }),
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
        search: (() => Effect.succeed("llamacpp")) as TerminalService["search"],
        ask: (message) => {
          asked.push(message);
          if (message.includes("API Key")) {
            return Effect.succeed("server-secret");
          }
          if (message.includes("Name")) {
            return Effect.succeed("keyed-agent");
          }
          return Effect.succeed("");
        },
        select: (() => Effect.succeed("default")) as TerminalService["select"],
        warn: (message) => {
          warnings.push(String(message));
          return Effect.void;
        },
      }),
      new Set(),
    );

    expect(result).toMatchObject({ llmProvider: "llamacpp", name: "keyed-agent" });
    expect(warnings).toContain(
      "The llama.cpp server at http://127.0.0.1:8090 rejected the request (401).",
    );
    expect(asked.some((message) => message.includes("server URL"))).toBe(false);
    expect(saved).toEqual([{ key: "llm.llamacpp.api_key", value: "server-secret" }]);
  });
});
