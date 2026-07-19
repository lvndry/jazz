import { describe, expect, it, mock } from "bun:test";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { listAgentsCommand, deleteAgentCommand } from "./agent-management";
import { AgentConfigServiceTag, type AgentConfigService } from "../../core/interfaces/agent-config";
import { AgentServiceTag, type AgentService } from "../../core/interfaces/agent-service";
import { CLIOptionsTag, type CLIOptions } from "../../core/interfaces/cli-options";
import { TerminalServiceTag, type TerminalService } from "../../core/interfaces/terminal";
import { CLIError } from "../../core/types/errors";
import { type Agent, type AppConfig } from "../../core/types/index";

const testAgent = {
  id: "a1",
  name: "agent1",
  config: { llmProvider: "anthropic", llmModel: "claude-sonnet-5" },
} as Agent;

// Mock dependencies
const mockAgentService = {
  listAgents: mock(() => Effect.succeed([])),
  getAgent: mock(() => Effect.succeed({ id: "a1", name: "agent1" } as Agent)),
  deleteAgent: mock(() => Effect.void),
} as unknown as AgentService;

const mockTerminal = {
  isInteractive: true,
  info: mock(() => Effect.void),
  log: mock(() => Effect.void),
  success: mock(() => Effect.void),
  error: mock(() => Effect.void),
  warn: mock(() => Effect.void),
  ask: mock(() => Effect.succeed("")),
  confirm: mock(() => Effect.succeed(true)),
} as unknown as TerminalService;

const mockPlainTerminal = {
  ...mockTerminal,
  isInteractive: false,
} as unknown as TerminalService;

const mockCLIOptions = {
  verbose: false,
} as unknown as CLIOptions;

const mockAgentConfigService = {
  get: () => Effect.succeed(null),
  getOrElse: (_key: string, fallback: unknown) => Effect.succeed(fallback),
  getOrFail: () => Effect.fail(new Error("not found")),
  has: () => Effect.succeed(false),
  set: () => Effect.void,
  appConfig: Effect.succeed({} as AppConfig),
} as unknown as AgentConfigService;

describe("Agent Management Commands", () => {
  const testLayer = Layer.mergeAll(
    Layer.succeed(AgentServiceTag, mockAgentService),
    Layer.succeed(TerminalServiceTag, mockTerminal),
    Layer.succeed(CLIOptionsTag, mockCLIOptions),
    Layer.succeed(AgentConfigServiceTag, mockAgentConfigService),
  );

  it("should list agents and show info if empty", async () => {
    // @ts-expect-error - mocking
    mockAgentService.listAgents.mockReturnValueOnce(Effect.succeed([]));

    const program = listAgentsCommand();
    const runnable = program.pipe(Effect.provide(testLayer)) as Effect.Effect<void, unknown, never>;
    await Effect.runPromise(runnable);

    expect(mockTerminal.info).toHaveBeenCalledWith(expect.stringContaining("No agents found"));
  });

  it("should delete an agent after interactive confirmation", async () => {
    // @ts-expect-error - mocking
    mockAgentService.getAgent.mockReturnValueOnce(Effect.succeed(testAgent));
    // @ts-expect-error - mocking
    mockAgentService.deleteAgent.mockReturnValueOnce(Effect.void);
    // @ts-expect-error - mocking
    mockTerminal.confirm.mockReturnValueOnce(Effect.succeed(true));

    const program = deleteAgentCommand("agent1");
    const runnable = program.pipe(Effect.provide(testLayer)) as Effect.Effect<void, unknown, never>;
    await Effect.runPromise(runnable);

    expect(mockTerminal.confirm).toHaveBeenCalledWith(
      expect.stringContaining('Delete agent "agent1" (anthropic/claude-sonnet-5)?'),
      false,
    );
    expect(mockAgentService.deleteAgent).toHaveBeenCalledWith("a1");
    expect(mockTerminal.success).toHaveBeenCalledWith(
      expect.stringContaining("deleted successfully"),
    );
  });

  it("should not delete when confirmation is declined", async () => {
    // @ts-expect-error - mocking
    mockAgentService.deleteAgent.mockClear();
    // @ts-expect-error - mocking
    mockAgentService.getAgent.mockReturnValueOnce(Effect.succeed(testAgent));
    // @ts-expect-error - mocking
    mockTerminal.confirm.mockReturnValueOnce(Effect.succeed(false));

    const program = deleteAgentCommand("agent1");
    const runnable = program.pipe(Effect.provide(testLayer)) as Effect.Effect<void, unknown, never>;
    await Effect.runPromise(runnable);

    expect(mockAgentService.deleteAgent).not.toHaveBeenCalled();
    expect(mockTerminal.info).toHaveBeenCalledWith(expect.stringContaining("cancelled"));
  });

  it("should delete without prompting when skipConfirmation is set", async () => {
    // @ts-expect-error - mocking
    mockTerminal.confirm.mockClear();
    // @ts-expect-error - mocking
    mockAgentService.getAgent.mockReturnValueOnce(Effect.succeed(testAgent));
    // @ts-expect-error - mocking
    mockAgentService.deleteAgent.mockReturnValueOnce(Effect.void);

    const program = deleteAgentCommand("agent1", { skipConfirmation: true });
    const runnable = program.pipe(Effect.provide(testLayer)) as Effect.Effect<void, unknown, never>;
    await Effect.runPromise(runnable);

    expect(mockTerminal.confirm).not.toHaveBeenCalled();
    expect(mockAgentService.deleteAgent).toHaveBeenCalledWith("a1");
  });

  it("should fail with CLIError in non-interactive sessions without --yes", async () => {
    // @ts-expect-error - mocking
    mockAgentService.deleteAgent.mockClear();
    // @ts-expect-error - mocking
    mockAgentService.getAgent.mockReturnValueOnce(Effect.succeed(testAgent));

    const plainLayer = Layer.mergeAll(
      Layer.succeed(AgentServiceTag, mockAgentService),
      Layer.succeed(TerminalServiceTag, mockPlainTerminal),
      Layer.succeed(CLIOptionsTag, mockCLIOptions),
      Layer.succeed(AgentConfigServiceTag, mockAgentConfigService),
    );
    const program = deleteAgentCommand("agent1");
    const runnable = program.pipe(Effect.provide(plainLayer)) as Effect.Effect<
      void,
      unknown,
      never
    >;
    const exit = await Effect.runPromiseExit(runnable);

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value).toBeInstanceOf(CLIError);
      }
    }
    expect(mockAgentService.deleteAgent).not.toHaveBeenCalled();
  });
});
