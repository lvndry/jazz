import type { AgentConfigService } from "@jazz/core/interfaces/agent-config";
import type { TerminalService } from "@jazz/core/interfaces/terminal";
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { ensureLocalProviderBaseUrl } from "./local-provider-url";

function configService(options: {
  readonly appConfig: Record<string, unknown>;
  readonly set: (key: string, value: unknown) => void;
}): AgentConfigService {
  return {
    appConfig: Effect.succeed(options.appConfig as never),
    set: <A>(key: string, value: A) => {
      options.set(key, value);
      return Effect.void;
    },
  } as unknown as AgentConfigService;
}

function terminal(options: {
  readonly ask: TerminalService["ask"];
  readonly success?: TerminalService["success"];
}): TerminalService {
  return {
    ask: options.ask,
    success: options.success ?? (() => Effect.void),
  } as TerminalService;
}

describe("ensureLocalProviderBaseUrl", () => {
  it("uses vLLM's port and stores the OpenAI-compatible API path", async () => {
    const saved: Array<{ key: string; value: unknown }> = [];
    const placeholders: Array<string | undefined> = [];

    const result = await ensureLocalProviderBaseUrl({
      provider: "vllm",
      configService: configService({
        appConfig: {},
        set: (key, value) => saved.push({ key, value }),
      }),
      terminal: terminal({
        ask: (_message, options) => {
          placeholders.push(options?.placeholder);
          return Effect.succeed("gpu.example:8000");
        },
      }),
    });

    expect(result).toBe("saved");
    expect(placeholders).toEqual(["http://127.0.0.1:8000"]);
    expect(saved).toEqual([{ key: "llm.vllm.base_url", value: "http://gpu.example:8000/v1" }]);
  });

  it("asks once and normalizes a llama.cpp host:port", async () => {
    const asked: Array<{ message: string; defaultValue?: string; placeholder?: string }> = [];
    const saved: Array<{ key: string; value: unknown }> = [];

    const result = await ensureLocalProviderBaseUrl({
      provider: "llamacpp",
      configService: configService({
        appConfig: {},
        set: (key, value) => saved.push({ key, value }),
      }),
      terminal: terminal({
        ask: (message, options) => {
          const entry: { message: string; defaultValue?: string; placeholder?: string } = {
            message,
          };
          if (options?.defaultValue !== undefined) {
            entry.defaultValue = options.defaultValue;
          }
          if (options?.placeholder !== undefined) {
            entry.placeholder = options.placeholder;
          }
          asked.push(entry);
          return Effect.succeed("gpu.example:8000");
        },
      }),
    });

    expect(result).toBe("saved");
    expect(asked[0]?.defaultValue).toBeUndefined();
    expect(asked[0]?.placeholder).toBe("http://127.0.0.1:8080");
    expect(saved).toEqual([{ key: "llm.llamacpp.base_url", value: "http://gpu.example:8000/v1" }]);
  });

  it("uses the loopback default when the first-use prompt is submitted empty", async () => {
    const saved: Array<{ key: string; value: unknown }> = [];

    await ensureLocalProviderBaseUrl({
      provider: "ollama",
      configService: configService({
        appConfig: {},
        set: (key, value) => saved.push({ key, value }),
      }),
      terminal: terminal({ ask: () => Effect.succeed("") }),
    });

    expect(saved).toEqual([{ key: "llm.ollama.base_url", value: "http://127.0.0.1:11434/api" }]);
  });

  it("does not prompt again after a URL is configured", async () => {
    let promptCount = 0;

    const result = await ensureLocalProviderBaseUrl({
      provider: "ollama",
      configService: configService({
        appConfig: { llm: { ollama: { base_url: "http://gpu.example:11434/api" } } },
        set: () => {},
      }),
      terminal: terminal({
        ask: () => {
          promptCount += 1;
          return Effect.succeed("should-not-be-used");
        },
      }),
    });

    expect(result).toBe("already-set");
    expect(promptCount).toBe(0);
  });

  it("re-prompts over a saved URL when forced, offering its address as the default", async () => {
    const placeholders: Array<string | undefined> = [];
    const saved: Array<{ key: string; value: unknown }> = [];

    const result = await ensureLocalProviderBaseUrl({
      provider: "llamacpp",
      force: true,
      configService: configService({
        appConfig: { llm: { llamacpp: { base_url: "http://gpu.example:8000/v1" } } },
        set: (key, value) => saved.push({ key, value }),
      }),
      terminal: terminal({
        ask: (_message, options) => {
          placeholders.push(options?.placeholder);
          return Effect.succeed("gpu.example:9000");
        },
      }),
    });

    expect(result).toBe("saved");
    expect(placeholders).toEqual(["http://gpu.example:8000"]);
    expect(saved).toEqual([{ key: "llm.llamacpp.base_url", value: "http://gpu.example:9000/v1" }]);
  });

  it("never prompts over an env-var URL, even when forced", async () => {
    const original = process.env["LLAMACPP_BASE_URL"];
    let promptCount = 0;
    try {
      process.env["LLAMACPP_BASE_URL"] = "http://gpu.example:8000/v1";
      const result = await ensureLocalProviderBaseUrl({
        provider: "llamacpp",
        force: true,
        configService: configService({ appConfig: {}, set: () => {} }),
        terminal: terminal({
          ask: () => {
            promptCount += 1;
            return Effect.succeed("should-not-be-used");
          },
        }),
      });

      expect(result).toBe("already-set");
      expect(promptCount).toBe(0);
    } finally {
      if (original === undefined) {
        delete process.env["LLAMACPP_BASE_URL"];
      } else {
        process.env["LLAMACPP_BASE_URL"] = original;
      }
    }
  });
});
