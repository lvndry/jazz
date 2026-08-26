import type { AgentConfigService } from "@jazz/core/interfaces/agent-config";
import type { LLMService } from "@jazz/core/interfaces/llm";
import type { TerminalService } from "@jazz/core/interfaces/terminal";
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { handleWebSearchConfiguration } from "./web-search";

function stubTerminal(overrides: {
  readonly select: TerminalService["select"];
  readonly ask: TerminalService["ask"];
}): TerminalService {
  return {
    isInteractive: true,
    info: () => Effect.void,
    success: () => Effect.void,
    warn: () => Effect.void,
    error: () => Effect.void,
    debug: () => Effect.void,
    log: () => Effect.void,
    heading: () => Effect.void,
    list: () => Effect.void,
    clear: () => Effect.void,
    user: () => Effect.void,
    setTitle: () => Effect.void,
    password: () => Effect.succeed(""),
    confirm: () => Effect.succeed(false),
    search: () => Effect.succeed(undefined),
    checkbox: () => Effect.succeed([]),
    ...overrides,
  } as TerminalService;
}

function stubConfig(overrides: {
  readonly has: AgentConfigService["has"];
  readonly set?: AgentConfigService["set"];
}): AgentConfigService {
  return {
    has: overrides.has,
    set: overrides.set ?? (() => Effect.void),
  } as AgentConfigService;
}

function stubLlm(supportsNative: boolean): LLMService {
  return {
    supportsNativeWebSearch: () => Effect.succeed(supportsNative),
  } as unknown as LLMService;
}

function runWebSearch(terminal: TerminalService, configService: AgentConfigService) {
  return Effect.runPromise(
    handleWebSearchConfiguration(terminal, configService, stubLlm(false), "openai"),
  );
}

describe("handleWebSearchConfiguration", () => {
  it("returns to the provider picker when Esc is pressed on the API key prompt", async () => {
    let selectCalls = 0;
    let savedKey: string | undefined;
    const terminal = stubTerminal({
      select: (() => {
        selectCalls += 1;
        if (selectCalls === 1) return Effect.succeed("tavily");
        return Effect.succeed("back");
      }) as TerminalService["select"],
      ask: () => Effect.succeed(undefined),
    });
    const configService = stubConfig({
      has: () => Effect.succeed(false),
      set: () => {
        savedKey = "should-not-save";
        return Effect.void;
      },
    });

    const result = await runWebSearch(terminal, configService);

    expect(result).toBe(false);
    expect(selectCalls).toBe(2);
    expect(savedKey).toBeUndefined();
  });

  it("stays in the flow after Esc and accepts a later provider choice", async () => {
    let selectCalls = 0;
    const askedFor: string[] = [];
    const terminal = stubTerminal({
      select: (() => {
        selectCalls += 1;
        if (selectCalls === 1) return Effect.succeed("tavily");
        return Effect.succeed("linkup");
      }) as TerminalService["select"],
      ask: (message) => {
        askedFor.push(message);
        if (message.includes("tavily")) return Effect.succeed(undefined);
        return Effect.succeed("linkup-key");
      },
    });
    const saved: Array<{ key: string; value: unknown }> = [];
    const configService = stubConfig({
      has: () => Effect.succeed(false),
      set: (key, value) => {
        saved.push({ key, value });
        return Effect.void;
      },
    });

    const result = await runWebSearch(terminal, configService);

    expect(askedFor).toEqual(["Enter API Key for tavily:", "Enter API Key for linkup:"]);
    expect(result).toBe("linkup");
    expect(saved).toEqual([{ key: "web_search.linkup.api_key", value: "linkup-key" }]);
    expect(selectCalls).toBe(2);
  });
});
