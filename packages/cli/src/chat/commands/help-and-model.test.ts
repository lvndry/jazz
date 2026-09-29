import { type LLMService, LLMServiceTag } from "@jazz/core/interfaces/llm";
import {
  isTerminalReport,
  TerminalServiceTag,
  type TerminalService,
} from "@jazz/core/interfaces/terminal";
import type { Agent } from "@jazz/core/types/agent";
import type { ModelInfo } from "@jazz/core/types/llm";
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { Effect, Layer } from "effect";
import { getGlyphs } from "@/cli/ui/glyphs";
import { setActiveKeymap } from "@/cli/ui/keymaps";
import { reportPlainText } from "@/cli/ui/report-layout";
import { setSkillCommands } from "./constants";
import { handleSpecialCommand } from "./handler";
import type { CommandContext, CommandResult, SpecialCommand } from "./types";

const agent: Agent = {
  id: "help-model-agent",
  name: "Helper",
  config: { persona: "default", llm: { provider: "openai", model: "gpt-4.1" }, tools: [] },
  createdAt: new Date(),
  updatedAt: new Date(),
};

const context: CommandContext = {
  agent,
  conversationHistory: [],
  conversationId: "help-model-session",
  sessionUsage: { promptTokens: 0, completionTokens: 0 },
  sessionTurnCount: 0,
  sessionLimits: {},
  sessionStartedAt: new Date(),
};

const MODELS = [
  { id: "gpt-4.1", displayName: "GPT-4.1", isReasoningModel: false },
  { id: "gpt-5", displayName: "GPT-5", isReasoningModel: true },
] as ModelInfo[];

function recordingTerminal(overrides: Partial<TerminalService> = {}) {
  const lines: string[] = [];
  const record = (message: unknown) => {
    lines.push(
      isTerminalReport(message)
        ? reportPlainText(message, getGlyphs(), process.stdout.columns || undefined)
        : String(message),
    );
    return Effect.succeed(undefined);
  };
  const terminal = {
    isInteractive: false,
    log: mock(record),
    info: mock(record),
    warn: mock(record),
    error: mock(record),
    success: mock(record),
    ...overrides,
  } as unknown as Partial<TerminalService>;
  return { terminal, lines };
}

function run(
  command: SpecialCommand,
  terminal: Partial<TerminalService>,
  models: readonly ModelInfo[] = MODELS,
): Promise<CommandResult> {
  const llmService: Partial<LLMService> = {
    getProvider: () =>
      Effect.succeed({
        name: "openai",
        supportedModels: [...models],
        defaultModel: "gpt-4.1",
        authenticate: () => Effect.void,
      }),
  };
  const layers = Layer.mergeAll(
    Layer.succeed(TerminalServiceTag, terminal as unknown as TerminalService),
    Layer.succeed(LLMServiceTag, llmService as unknown as LLMService),
  );
  return Effect.runPromise(
    handleSpecialCommand(command, context).pipe(Effect.provide(layers)) as Effect.Effect<
      CommandResult,
      unknown,
      never
    >,
  );
}

const plain = (lines: readonly string[]) =>
  lines.join("\n").replace(new RegExp(String.raw`\u001b\[[0-9;]*m`, "g"), "");

let previousOffline: string | undefined;
beforeAll(() => {
  previousOffline = process.env["JAZZ_OFFLINE"];
  process.env["JAZZ_OFFLINE"] = "1";
});
afterAll(() => {
  if (previousOffline === undefined) {
    delete process.env["JAZZ_OFFLINE"];
  } else {
    process.env["JAZZ_OFFLINE"] = previousOffline;
  }
});

afterEach(() => {
  setSkillCommands([]);
  setActiveKeymap("classic");
});

describe("/help", () => {
  test("lists skills in their own section and the running interface's keys", async () => {
    setSkillCommands([{ name: "deep-research", description: "Research a topic in depth" }]);
    setActiveKeymap("fullscreen");
    const { terminal, lines } = recordingTerminal();

    await run({ type: "help", args: [] }, terminal);

    const output = plain(lines);
    expect(output).toContain("skills");
    expect(output).toContain("/deep-research");
    expect(output).toContain("Ctrl+F");
  });

  test("shows the classic keys when the classic interface is running", async () => {
    const { terminal, lines } = recordingTerminal();

    await run({ type: "help", args: [] }, terminal);

    const output = plain(lines);
    expect(output).toContain("Ctrl+W");
    expect(output).not.toContain("Ctrl+F");
  });

  test("keeps every row inside a narrow terminal", async () => {
    const columns = process.stdout.columns;
    Object.defineProperty(process.stdout, "columns", { value: 60, configurable: true });
    try {
      const { terminal, lines } = recordingTerminal();
      await run({ type: "help", args: [] }, terminal);
      const tooWide = plain(lines)
        .split("\n")
        .filter((line) => line.length > 60);
      expect(tooWide).toEqual([]);
    } finally {
      Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
    }
  });

  test("shows every form of one command, by alias too", async () => {
    const { terminal, lines } = recordingTerminal();

    await run({ type: "help", args: ["goal"] }, terminal);
    expect(plain(lines)).toContain("/goal resume [note]");

    const alias = recordingTerminal();
    await run({ type: "help", args: ["stats"] }, alias.terminal);
    expect(plain(alias.lines)).toContain("/info");
  });

  test("suggests the closest command for a typo", async () => {
    const { terminal, lines } = recordingTerminal();

    await run({ type: "help", args: ["resum"] }, terminal);

    expect(plain(lines)).toContain("Did you mean /resume?");
  });
});

describe("unknown commands", () => {
  test("suggest the closest command and keep the draft", async () => {
    const { terminal, lines } = recordingTerminal();

    const result = await run({ type: "unknown", args: ["halp"] }, terminal);

    expect(result.keepDraft).toBe(true);
    expect(plain(lines)).toContain("Did you mean /help?");
  });
});

describe("/model", () => {
  test("switches the model for this session without touching the agent", async () => {
    const { terminal } = recordingTerminal();

    const result = await run({ type: "model", args: ["gpt-5"] }, terminal);

    expect(result.newAgent?.config.llm.model).toBe("gpt-5");
    expect(result.newAgent?.config.llm.provider).toBe("openai");
    expect(agent.config.llm.model).toBe("gpt-4.1");
  });

  test("accepts the provider-qualified form", async () => {
    const { terminal } = recordingTerminal();

    const result = await run({ type: "model", args: ["openai/gpt-5"] }, terminal);

    expect(result.newAgent?.config.llm.model).toBe("gpt-5");
  });

  test("refuses a model the provider does not list, with a suggestion", async () => {
    const { terminal, lines } = recordingTerminal();

    const result = await run({ type: "model", args: ["gpt-55"] }, terminal);

    expect(result.newAgent).toBeUndefined();
    expect(result.keepDraft).toBe(true);
    expect(plain(lines)).toContain("Did you mean gpt-5?");
  });

  test("opens a picker on an interactive terminal", async () => {
    const search = mock(() => Effect.succeed("gpt-5"));
    const { terminal } = recordingTerminal({
      isInteractive: true,
      search: search as unknown as TerminalService["search"],
    });

    const result = await run({ type: "model", args: [] }, terminal);

    expect(search).toHaveBeenCalled();
    expect(result.newAgent?.config.llm.model).toBe("gpt-5");
  });

  test("prints the current model when the terminal cannot prompt", async () => {
    const { terminal, lines } = recordingTerminal();

    const result = await run({ type: "model", args: [] }, terminal);

    expect(result.newAgent).toBeUndefined();
    expect(plain(lines)).toContain("openai/gpt-4.1");
  });
});
