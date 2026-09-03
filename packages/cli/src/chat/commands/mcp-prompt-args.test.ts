import { MCPServerManagerTag, type MCPServerManager } from "@jazz/core/interfaces/mcp-server";
import { TerminalServiceTag, type TerminalService } from "@jazz/core/interfaces/terminal";
import type { Agent } from "@jazz/core/types/agent";
import { describe, expect, mock, test } from "bun:test";
import { Effect, Layer } from "effect";
import { handleSpecialCommand } from "./handler";
import type { CommandContext, CommandResult } from "./types";

const agent = {
  id: "a",
  name: "A",
  config: { persona: "default", llmProvider: "openai", llmModel: "gpt-4", tools: [] },
} as unknown as Agent;

const context: CommandContext = {
  agent,
  conversationHistory: [],
  conversationId: "c",
  sessionUsage: { promptTokens: 0, completionTokens: 0 },
  sessionTurnCount: 0,
  sessionLimits: {},
  sessionStartedAt: new Date(),
};

const PROMPT = {
  name: "staff",
  description: "pick a team",
  arguments: [
    { name: "department", required: true },
    { name: "name", required: true },
  ],
};

/** Records every completion request so argument context can be asserted. */
function harness(options: {
  completions: Record<string, string[]>;
  selections: string[];
  typed?: string[];
}) {
  const completionCalls: { argument: string; resolved: Record<string, string> }[] = [];
  const selectCalls: string[] = [];
  let getPromptArgs: Record<string, string> = {};
  const selections = [...options.selections];
  const typed = [...(options.typed ?? [])];

  const manager = {
    getServerPrompts: () => Effect.succeed([PROMPT]),
    completeArgument: (
      _server: string,
      _ref: unknown,
      argumentName: string,
      _partial: string,
      resolved: Record<string, string> = {},
    ) => {
      completionCalls.push({ argument: argumentName, resolved: { ...resolved } });
      return Effect.succeed(options.completions[argumentName] ?? []);
    },
    getPrompt: (_server: string, _name: string, args: Record<string, string>) => {
      getPromptArgs = args;
      return Effect.succeed({
        messages: [{ role: "user", content: { type: "text", text: "ok" } }],
      });
    },
  } as unknown as MCPServerManager;

  const terminal = {
    log: mock(() => Effect.void),
    info: mock(() => Effect.void),
    warn: mock(() => Effect.void),
    error: mock(() => Effect.void),
    select: mock((message: string) => {
      selectCalls.push(message);
      return Effect.succeed(selections.shift());
    }),
    ask: mock(() => Effect.succeed(typed.shift())),
  } as unknown as TerminalService;

  const layer = Layer.mergeAll(
    Layer.succeed(MCPServerManagerTag, manager),
    Layer.succeed(TerminalServiceTag, terminal),
  );

  return { layer, completionCalls, selectCalls, getPromptArgs: () => getPromptArgs };
}

function run(layer: Layer.Layer<never, never, never>, args: string[]) {
  return Effect.runPromise(
    handleSpecialCommand({ type: "runMcpPrompt", args }, context).pipe(
      Effect.provide(layer),
    ) as Effect.Effect<CommandResult, unknown, never>,
  );
}

describe("MCP prompt argument filling", () => {
  test("asks for a missing required argument and offers the server's completions", async () => {
    const h = harness({
      completions: { department: ["Engineering", "Sales"], name: ["Alice"] },
      selections: ["Engineering", "Alice"],
    });

    const result = await run(h.layer as never, ["srv:staff"]);

    expect(h.selectCalls).toHaveLength(2);
    expect(h.getPromptArgs()).toEqual({ department: "Engineering", name: "Alice" });
    expect(result.resendMessage).toBe("ok");
  });

  test("passes already-chosen arguments as completion context", async () => {
    // A prompt may narrow one argument by an earlier one; without the context
    // the dependent argument completes to nothing and the picker vanishes.
    const h = harness({
      completions: { department: ["Engineering"], name: ["Alice"] },
      selections: ["Engineering", "Alice"],
    });

    await run(h.layer as never, ["srv:staff"]);

    expect(h.completionCalls[0]).toEqual({ argument: "department", resolved: {} });
    expect(h.completionCalls[1]).toEqual({
      argument: "name",
      resolved: { department: "Engineering" },
    });
  });

  test("does not re-ask for an argument supplied inline", async () => {
    const h = harness({ completions: { name: ["Alice"] }, selections: ["Alice"] });

    await run(h.layer as never, ["srv:staff", "department=Sales"]);

    expect(h.completionCalls.map((call) => call.argument)).toEqual(["name"]);
    expect(h.getPromptArgs()).toEqual({ department: "Sales", name: "Alice" });
  });

  test("falls back to free text when the server offers no completions", async () => {
    const h = harness({ completions: {}, selections: [], typed: ["Ops", "Dana"] });

    await run(h.layer as never, ["srv:staff"]);

    expect(h.selectCalls).toHaveLength(0);
    expect(h.getPromptArgs()).toEqual({ department: "Ops", name: "Dana" });
  });

  test("cancels cleanly when the user dismisses a picker", async () => {
    const h = harness({
      completions: { department: ["Engineering"] },
      selections: [undefined as never],
    });

    const result = await run(h.layer as never, ["srv:staff"]);

    expect(result.resendMessage).toBeUndefined();
    expect(result.shouldContinue).toBe(true);
  });
});
