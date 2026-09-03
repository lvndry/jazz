import { TerminalServiceTag, type TerminalService } from "@jazz/core/interfaces/terminal";
import type { Agent } from "@jazz/core/types/agent";
import type { ModelsDevMetadata } from "@jazz/core/utils/models-dev";
import { describe, expect, it, mock } from "bun:test";
import { Effect, Layer } from "effect";
import type { CommandContext, CommandResult } from "./types";

mock.module("@jazz/core/utils/models-dev", () => ({
  getModelsDevMetadata: () =>
    Promise.resolve({ inputPricePerMillion: 3, outputPricePerMillion: 15 } as ModelsDevMetadata),
  getModelsDevProviderModels: () => Promise.resolve([]),
}));

const { handleSpecialCommand } = await import("./handler");

const testAgent = {
  id: "a",
  name: "A",
  config: { persona: "default", llmProvider: "openai", llmModel: "gpt-4", tools: [] },
} as unknown as Agent;

function baseContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    agent: testAgent,
    conversationHistory: [],
    conversationId: "c",
    sessionUsage: { promptTokens: 0, completionTokens: 0 },
    sessionTurnCount: 0,
    sessionLimits: {},
    sessionStartedAt: new Date(),
    ...overrides,
  };
}

function runLimit(
  args: string[],
  context: CommandContext,
  terminal: Partial<TerminalService>,
): Promise<CommandResult> {
  const fullTerminal: Partial<TerminalService> = {
    log: mock(() => Effect.succeed(undefined)),
    ...terminal,
  };
  const terminalLayer = Layer.succeed(
    TerminalServiceTag,
    fullTerminal as unknown as TerminalService,
  );
  return Effect.runPromise(
    handleSpecialCommand({ type: "limit", args }, context).pipe(
      Effect.provide(terminalLayer),
    ) as Effect.Effect<CommandResult, unknown, never>,
  );
}

describe("handleSpecialCommand /limit", () => {
  it("sets a direct usd limit", async () => {
    const success = mock(() => Effect.void);
    const result = await runLimit(["usd", "5"], baseContext(), { success });
    expect(result.newSessionLimits).toEqual({ maxCostUSD: 5 });
    expect(success).toHaveBeenCalledWith(expect.stringContaining("Session usd limit set to $5.00"));
  });

  it("sets a direct turns limit", async () => {
    const result = await runLimit(["turns", "10"], baseContext(), {
      success: mock(() => Effect.void),
    });
    expect(result.newSessionLimits).toEqual({ maxTurns: 10 });
  });

  it("accepts metric aliases", async () => {
    const result = await runLimit(["cost", "2.5"], baseContext(), {
      success: mock(() => Effect.void),
    });
    expect(result.newSessionLimits).toEqual({ maxCostUSD: 2.5 });
  });

  it("clears one metric, keeping the others", async () => {
    const result = await runLimit(
      ["usd", "clear"],
      baseContext({ sessionLimits: { maxCostUSD: 5, maxTurns: 10 } }),
      { success: mock(() => Effect.void) },
    );
    expect(result.newSessionLimits).toEqual({ maxTurns: 10 });
  });

  it("clears every limit with /limit clear", async () => {
    const result = await runLimit(
      ["clear"],
      baseContext({ sessionLimits: { maxCostUSD: 5, maxTurns: 10 } }),
      { success: mock(() => Effect.void) },
    );
    expect(result.newSessionLimits).toEqual({});
  });

  it("rejects an unknown metric without touching sessionLimits", async () => {
    const error = mock(() => Effect.void);
    const result = await runLimit(["bogus", "5"], baseContext(), { error });
    expect(result.newSessionLimits).toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Unknown limit "bogus"'));
  });

  it("rejects a non-numeric value", async () => {
    const error = mock(() => Effect.void);
    const result = await runLimit(["usd", "abc"], baseContext(), { error });
    expect(result.newSessionLimits).toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Invalid value "abc"'));
  });

  it("warns and asks to continue when the new limit is already exceeded", async () => {
    const warn = mock(() => Effect.void);
    const confirm = mock(() => Effect.succeed(false));
    const result = await runLimit(["turns", "1"], baseContext({ sessionTurnCount: 3 }), {
      success: mock(() => Effect.void),
      warn,
      confirm,
    });
    // The limit is applied regardless of the answer — enforcement happens on
    // the next turn attempt in the chat loop, not inside /limit itself.
    expect(result.newSessionLimits).toEqual({ maxTurns: 1 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("turns limit reached"));
    expect(confirm).toHaveBeenCalled();
  });

  it("prints status without prompting on a non-interactive terminal", async () => {
    const info = mock(() => Effect.void);
    const result = await runLimit([], baseContext({ sessionLimits: { maxTurns: 10 } }), {
      isInteractive: false,
      info,
    });
    expect(result).toEqual({ shouldContinue: true });
    expect(info).toHaveBeenCalled();
  });

  it("opens the picker and applies the selected metric+value on an interactive terminal", async () => {
    const select = mock(() => Effect.succeed("tokens")) as unknown as TerminalService["select"];
    const ask = mock(() => Effect.succeed("100000")) as unknown as TerminalService["ask"];
    const success = mock(() => Effect.void);
    const result = await runLimit([], baseContext(), {
      isInteractive: true,
      select,
      ask,
      success,
    });
    expect(result.newSessionLimits).toEqual({ maxTokens: 100_000 });
  });
});
