import { AgentConfigServiceTag, type AgentConfigService } from "@jazz/core/interfaces/agent-config";
import { TerminalServiceTag, type TerminalService } from "@jazz/core/interfaces/terminal";
import { ConfigurationValidationError } from "@jazz/core/types/errors";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { Cause, Effect, Exit, Layer } from "effect";
import { setConfigCommand } from "./config";

/**
 * `jazz config set` receives every value as a shell string, but most of
 * AppConfig is typed. These cover the boundary: what reaches
 * `AgentConfigService.set` has to be the type the setting is read back as, or
 * the write lands in config.json and is then ignored by whoever reads it.
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

const mockTerminal = {
  isInteractive: true,
  info: mock(() => Effect.void),
  log: mock(() => Effect.void),
  success: mock(() => Effect.void),
  error: mock(() => Effect.void),
  warn: mock(() => Effect.void),
  ask: mock(() => Effect.succeed(askAnswer.value)),
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

beforeEach(() => {
  writes = [];
  askAnswer.value = "";
});

describe("jazz config set", () => {
  it("stores a numeric setting as a number, not the string it arrived as", async () => {
    const exit = await set("llm.streamIdleTimeoutMs", "600000");

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(writes).toEqual([{ key: "llm.streamIdleTimeoutMs", value: 600000 }]);
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

  it("leaves genuinely stringly settings alone", async () => {
    await set("llm.ollama.keep_alive", "-1");
    await set("logging.level", "debug");

    expect(writes).toEqual([
      { key: "llm.ollama.keep_alive", value: "-1" },
      { key: "logging.level", value: "debug" },
    ]);
  });

  it("refuses a value it cannot read as the declared type instead of writing it", async () => {
    const exit = await set("maxRetries", "abc");

    expect(Exit.isFailure(exit)).toBe(true);
    const error = Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : undefined;
    expect(error?._tag === "Some" && error.value).toBeInstanceOf(ConfigurationValidationError);
    expect(error?._tag === "Some" && error.value.expected).toBe("a whole number");
    expect(writes).toEqual([]);
  });

  it("types the value typed at the interactive prompt too", async () => {
    askAnswer.value = "7";
    const exit = await set("maxRetries");

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(writes).toEqual([{ key: "maxRetries", value: 7 }]);
  });
});
