import { AgentConfigServiceTag, type AgentConfigService } from "@jazz/core/interfaces/agent-config";
import { TerminalServiceTag, type TerminalService } from "@jazz/core/interfaces/terminal";
import { ConfigurationValidationError } from "@jazz/core/types/errors";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { Cause, Effect, Exit, Layer } from "effect";
import { getConfigCommand, listConfigCommand, setConfigCommand } from "./config";

/**
 * `jazz config set` receives every value as a shell string, but most of
 * AppConfig is typed. These cover the boundary: what reaches
 * `AgentConfigService.set` has to be the type the setting is read back as, and
 * a key Jazz never reads has to be refused rather than written.
 */

let writes: { key: string; value: unknown }[] = [];

const mockConfigService = {
  set: mock((key: string, value: unknown) => {
    writes.push({ key, value });
    return Effect.void;
  }),
  getOrElse: mock(() => Effect.succeed(undefined)),
  secretStorageUnavailable: () => false,
} as unknown as AgentConfigService;

const askAnswer = { value: "" };
const ask = mock(() => Effect.succeed(askAnswer.value));

const mockTerminal = {
  isInteractive: true,
  info: mock(() => Effect.void),
  log: mock(() => Effect.void),
  success: mock(() => Effect.void),
  error: mock(() => Effect.void),
  warn: mock(() => Effect.void),
  ask,
  confirm: mock(() => Effect.succeed(true)),
} as unknown as TerminalService;

const testLayer = Layer.mergeAll(
  Layer.succeed(AgentConfigServiceTag, mockConfigService),
  Layer.succeed(TerminalServiceTag, mockTerminal),
);

function set(key: string, value?: string) {
  return Effect.runPromiseExit(
    setConfigCommand(key, value).pipe(Effect.provide(testLayer)) as Effect.Effect<
      void,
      ConfigurationValidationError,
      never
    >,
  );
}

function failure(exit: Exit.Exit<void, ConfigurationValidationError>) {
  const error = Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : undefined;
  return error?._tag === "Some" ? error.value : undefined;
}

beforeEach(() => {
  writes = [];
  askAnswer.value = "";
  ask.mockClear();
});

describe("jazz config set", () => {
  it("stores a numeric setting as a number, not the string it arrived as", async () => {
    const exit = await set("llm.streamIdleTimeoutMs", "600000");

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(writes).toEqual([{ key: "llm.streamIdleTimeoutMs", value: 600000 }]);
  });

  it("writes a model id containing dots through a quoted path segment", async () => {
    const path = 'llm.capabilityOverrides.nvidia."deepseek-ai/deepseek-v4.1-flash".supportsTools';

    const exit = await set(path, "true");

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(writes).toEqual([{ key: path, value: true }]);
  });

  it("prompts for the value of a non-key llm setting instead of an API key", async () => {
    askAnswer.value = "true";
    const path = 'llm.capabilityOverrides.nvidia."deepseek-ai/deepseek-v4.1-flash".supportsTools';

    const exit = await set(path);

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(ask).toHaveBeenCalledWith(`Enter value for ${path}:`, expect.anything());
    expect(writes).toEqual([{ key: path, value: true }]);
  });

  it("prompts for logging.format itself rather than the logging level", async () => {
    askAnswer.value = "json";

    const exit = await set("logging.format");

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(writes).toEqual([{ key: "logging.format", value: "json" }]);
  });

  it("stores a boolean setting as a boolean, so `!== false` checks see it", async () => {
    const exit = await set("output.collapseReasoning", "false");

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(writes).toEqual([{ key: "output.collapseReasoning", value: false }]);
  });

  it("types per-server MCP overrides, which the config service only records as booleans", async () => {
    await set("mcpServers.github.enabled", "false");

    expect(writes).toEqual([{ key: "mcpServers.github.enabled", value: false }]);
  });

  it("stores a choice as the value the setting names", async () => {
    await set("scheduler.mode", "in-process");

    expect(writes).toEqual([{ key: "scheduler.mode", value: "in-process" }]);
  });

  it("leaves genuinely stringly settings alone", async () => {
    await set("llm.ollama.keep_alive", "-1");
    await set("logging.level", "debug");

    expect(writes).toEqual([
      { key: "llm.ollama.keep_alive", value: "-1" },
      { key: "logging.level", value: "debug" },
    ]);
  });

  it("passes a secret through trimmed, including ones stored under a list", async () => {
    const exit = await set("webhooks.deploy.token", " s3cret\n");

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(writes).toEqual([{ key: "webhooks.deploy.token", value: "s3cret" }]);
  });

  it("refuses an API key for a provider that does not exist", async () => {
    for (const key of ["llm.opneai.api_key", "llm.opneai", "chatgpt"]) {
      const exit = await set(key, "sk-x");
      expect(failure(exit)).toBeInstanceOf(ConfigurationValidationError);
    }
    expect(failure(await set("llm.opneai.api_key", "sk-x"))?.suggestion).toContain("llm.openai");
    expect(writes).toEqual([]);
  });

  it("trims a pasted API key", async () => {
    const exit = await set("openai", "  sk-abc\n");

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(writes).toEqual([{ key: "llm.openai.api_key", value: "sk-abc" }]);
  });

  it("refuses a value it cannot read as the declared type instead of writing it", async () => {
    const exit = await set("maxRetries", "abc");

    const error = failure(exit);
    expect(error).toBeInstanceOf(ConfigurationValidationError);
    expect(error?.expected).toBe("a whole number of 0 or more");
    expect(writes).toEqual([]);
  });

  it("refuses a key Jazz never reads, suggesting the one a typo meant", async () => {
    const exit = await set("maxRetrys", "5");

    const error = failure(exit);
    expect(error?.field).toBe("maxRetrys");
    expect(error?.suggestion).toBe("Did you mean maxRetries?");
    expect(writes).toEqual([]);
  });

  it("refuses a single value for a whole section", async () => {
    const exit = await set("output", "hybrid");

    expect(failure(exit)?.field).toBe("output");
    expect(writes).toEqual([]);
  });

  it("types the value typed at the interactive prompt too", async () => {
    askAnswer.value = "7";
    const exit = await set("maxRetries");

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(writes).toEqual([{ key: "maxRetries", value: 7 }]);
  });

  it("refuses an unknown key before prompting for its value", async () => {
    const exit = await set("maxRetrys");

    expect(Exit.isFailure(exit)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
});

describe("jazz config get", () => {
  function getWith(appConfig: Record<string, unknown>, key: string) {
    const logged: string[] = [];
    const errors: string[] = [];
    const terminal = {
      isInteractive: false,
      info: mock(() => Effect.void),
      log: mock((message: string) => Effect.sync(() => logged.push(message))),
      error: mock((message: string) => Effect.sync(() => errors.push(message))),
    } as unknown as TerminalService;
    const configService = { appConfig: Effect.succeed(appConfig) } as unknown as AgentConfigService;
    const layer = Layer.mergeAll(
      Layer.succeed(AgentConfigServiceTag, configService),
      Layer.succeed(TerminalServiceTag, terminal),
    );
    return Effect.runPromise(getConfigCommand(key).pipe(Effect.provide(layer))).then(() => ({
      logged,
      errors,
    }));
  }

  it("prints only the value, a string as-is", async () => {
    const { logged, errors } = await getWith({ logging: { level: "debug" } }, "logging.level");

    expect(logged).toEqual(["debug"]);
    expect(errors).toEqual([]);
  });

  it("prints a non-string value as JSON", async () => {
    const { logged } = await getWith({ notifications: { enabled: true } }, "notifications");

    expect(logged).toEqual([JSON.stringify({ enabled: true }, null, 2)]);
  });

  it("reports a missing key as an error and exits 1", async () => {
    const previousExitCode = process.exitCode;
    try {
      const { logged, errors } = await getWith({}, "logging.level");

      expect(logged).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});

describe("jazz config show and get", () => {
  const appConfig = {
    llm: { openai: { api_key: "sk-live-key" } },
    mcpServers: {
      signoz: { name: "signoz", command: "signoz-mcp", env: { SIGNOZ_API_KEY: "sk-signoz" } },
    },
    logging: { level: "info" },
  };
  const printed: string[] = [];
  const readLayer = Layer.mergeAll(
    Layer.succeed(AgentConfigServiceTag, {
      appConfig: Effect.succeed(appConfig),
    } as unknown as AgentConfigService),
    Layer.succeed(TerminalServiceTag, {
      ...mockTerminal,
      log: (message: unknown) =>
        Effect.sync(() => {
          printed.push(String(message));
        }),
    } as unknown as TerminalService),
  );
  const output = async (
    effect: Effect.Effect<void, never, AgentConfigService | TerminalService>,
  ) => {
    printed.length = 0;
    await Effect.runPromise(effect.pipe(Effect.provide(readLayer)));
    return printed.join("\n");
  };

  it("show redacts keyring-merged and MCP env secrets by default", async () => {
    const shown = await output(listConfigCommand());

    expect(shown).not.toContain("sk-live-key");
    expect(shown).not.toContain("sk-signoz");
    expect(shown).toContain("<redacted>");
    expect(shown).toContain('"level": "info"');
  });

  it("show --reveal prints secrets in full", async () => {
    const shown = await output(listConfigCommand({ reveal: true }));

    expect(shown).toContain("sk-live-key");
    expect(shown).toContain("sk-signoz");
  });

  it("get redacts a secret and a section holding one unless revealed", async () => {
    expect(await output(getConfigCommand("llm.openai.api_key"))).not.toContain("sk-live-key");
    expect(await output(getConfigCommand("mcpServers"))).not.toContain("sk-signoz");
    expect(await output(getConfigCommand("llm.openai.api_key", { reveal: true }))).toContain(
      "sk-live-key",
    );
  });
});
