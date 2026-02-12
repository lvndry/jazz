import { describe, expect, it, mock } from "bun:test";
import { Effect, Layer } from "effect";
import { listAgentsCommand, deleteAgentCommand } from "./agent-management";
import { AgentServiceTag, type AgentService } from "../../core/interfaces/agent-service";
import { CLIOptionsTag, type CLIOptions } from "../../core/interfaces/cli-options";
import { TerminalServiceTag, type TerminalService } from "../../core/interfaces/terminal";
import { type Agent } from "../../core/types/index";

// Mock dependencies
const mockAgentService = {
  listAgents: mock(() => Effect.succeed([])),
  getAgent: mock(() => Effect.succeed({ id: "a1", name: "agent1" } as Agent)),
  deleteAgent: mock(() => Effect.void),
} as unknown as AgentService;

const mockTerminal = {
  info: mock(() => Effect.void),
  log: mock(() => Effect.void),
  success: mock(() => Effect.void),
  error: mock(() => Effect.void),
  warn: mock(() => Effect.void),
  ask: mock(() => Effect.succeed("")),
  confirm: mock(() => Effect.succeed(true)),
} as unknown as TerminalService;

const mockCLIOptions = {
  verbose: false,
} as unknown as CLIOptions;

describe("Agent Management Commands", () => {
  const testLayer = Layer.mergeAll(
    Layer.succeed(AgentServiceTag, mockAgentService),
    Layer.succeed(TerminalServiceTag, mockTerminal),
    Layer.succeed(CLIOptionsTag, mockCLIOptions),
  );

  it("should list agents and show info if empty", async () => {
    // @ts-expect-error - mocking
    mockAgentService.listAgents.mockReturnValueOnce(Effect.succeed([]));

    const program = listAgentsCommand();
    await Effect.runPromise(program.pipe(Effect.provide(testLayer)));

    expect(mockTerminal.info).toHaveBeenCalledWith(expect.stringContaining("No agents found"));
  });

  it("should delete an agent by identifier", async () => {
    const agent = { id: "a1", name: "agent1" } as Agent;
    // @ts-expect-error - mocking
    mockAgentService.getAgent.mockReturnValueOnce(Effect.succeed(agent));
    // @ts-expect-error - mocking
    mockAgentService.deleteAgent.mockReturnValueOnce(Effect.void);

    const program = deleteAgentCommand("agent1");
    await Effect.runPromise(program.pipe(Effect.provide(testLayer)));

    expect(mockAgentService.deleteAgent).toHaveBeenCalledWith("a1");
    expect(mockTerminal.success).toHaveBeenCalledWith(
      expect.stringContaining("deleted successfully"),
    );
  });
});
