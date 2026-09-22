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
  it("asks once and normalizes a llama.cpp host:port", async () => {
    const asked: Array<{ message: string; defaultValue?: string }> = [];
    const saved: Array<{ key: string; value: unknown }> = [];

    const result = await ensureLocalProviderBaseUrl({
      provider: "llamacpp",
      configService: configService({
        appConfig: {},
        set: (key, value) => saved.push({ key, value }),
      }),
      terminal: terminal({
        ask: (message, options) => {
          const entry: { message: string; defaultValue?: string } = { message };
          if (options?.defaultValue !== undefined) {
            entry.defaultValue = options.defaultValue;
          }
          asked.push(entry);
          return Effect.succeed("gpu.example:8000");
        },
      }),
    });

    expect(result).toBe("saved");
    expect(asked[0]?.defaultValue).toBe("http://127.0.0.1:8080");
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
});
