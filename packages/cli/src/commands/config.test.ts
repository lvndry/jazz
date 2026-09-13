import { AgentConfigServiceTag, type AgentConfigService } from "@jazz/core/interfaces/agent-config";
import { TerminalServiceTag, type TerminalService } from "@jazz/core/interfaces/terminal";
import { ConfigurationValidationError } from "@jazz/core/types/errors";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { Cause, Effect, Exit, Layer } from "effect";
import { setConfigCommand } from "./config";

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

  it("passes a secret through verbatim, including ones stored under a list", async () => {
    const exit = await set("webhooks.deploy.token", " s3cret ");

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(writes).toEqual([{ key: "webhooks.deploy.token", value: " s3cret " }]);
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
