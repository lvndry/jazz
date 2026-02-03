import { describe, expect, it, mock } from "bun:test";
import { Effect } from "effect";
import {
  createAgent,
  getAgentById,
  getAgentByIdentifier,
  listAllAgents,
} from "./agent-service";
import { AgentServiceTag, type AgentService } from "../interfaces/agent-service";
import { StorageNotFoundError } from "../types/errors";
import { type Agent } from "../types/index";

// Mock Agent Service
const mockAgentService = {
  createAgent: mock(() => Effect.succeed({} as Agent)),
  getAgent: mock(() => Effect.succeed({} as Agent)),
  listAgents: mock(() => Effect.succeed([])),
} as unknown as AgentService;

describe("Agent Convenience Functions", () => {
  const provideMockService = (program: Effect.Effect<any, any, AgentService>) =>
    program.pipe(Effect.provideService(AgentServiceTag, mockAgentService));

  describe("createAgent", () => {
    it("should call agentService.createAgent", async () => {
      const mockResult = { id: "1", name: "test" } as Agent;
      // @ts-expect-error - mocking
      mockAgentService.createAgent.mockReturnValueOnce(Effect.succeed(mockResult));

      const program = createAgent("test", "desc");
      const result = await Effect.runPromise(provideMockService(program));

      expect(result).toBe(mockResult);
      expect(mockAgentService.createAgent).toHaveBeenCalledWith("test", "desc", undefined);
    });
  });

  describe("getAgentById", () => {
    it("should call agentService.getAgent", async () => {
      const mockResult = { id: "1", name: "test" } as Agent;
      // @ts-expect-error - mocking
      mockAgentService.getAgent.mockReturnValueOnce(Effect.succeed(mockResult));

      const program = getAgentById("1");
      const result = await Effect.runPromise(provideMockService(program));

      expect(result).toBe(mockResult);
      expect(mockAgentService.getAgent).toHaveBeenCalledWith("1");
    });
  });

  describe("getAgentByIdentifier", () => {
    it("should find by ID first", async () => {
      const mockResult = { id: "id-1", name: "name-1" } as Agent;
      // @ts-expect-error - mocking
      mockAgentService.getAgent.mockReturnValueOnce(Effect.succeed(mockResult));

      const program = getAgentByIdentifier("id-1");
      const result = await Effect.runPromise(provideMockService(program));

      expect(result).toBe(mockResult);
      expect(mockAgentService.getAgent).toHaveBeenCalledWith("id-1");
    });

    it("should fall back to name if ID not found", async () => {
      const mockResult = { id: "id-1", name: "name-1" } as Agent;
      // @ts-expect-error - mocking
      mockAgentService.getAgent.mockReturnValueOnce(
        Effect.fail(new StorageNotFoundError({ path: "name-1" })),
      );
      // @ts-expect-error - mocking
      mockAgentService.listAgents.mockReturnValueOnce(Effect.succeed([mockResult]));

      const program = getAgentByIdentifier("name-1");
      const result = await Effect.runPromise(provideMockService(program));

      expect(result).toBe(mockResult);
      expect(mockAgentService.listAgents).toHaveBeenCalled();
    });

    it("should fail if neither ID nor name matches", async () => {
      // @ts-expect-error - mocking
      mockAgentService.getAgent.mockReturnValueOnce(
        Effect.fail(new StorageNotFoundError({ path: "none" })),
      );
      // @ts-expect-error - mocking
      mockAgentService.listAgents.mockReturnValueOnce(Effect.succeed([]));

      const program = getAgentByIdentifier("none");
      const result = await Effect.runPromiseExit(provideMockService(program));

      expect(result._tag).toBe("Failure");
    });
  });

  describe("listAllAgents", () => {
    it("should call agentService.listAgents", async () => {
      const mockResult = [{ id: "1" }] as Agent[];
      // @ts-expect-error - mocking
      mockAgentService.listAgents.mockReturnValueOnce(Effect.succeed(mockResult));

      const program = listAllAgents();
      const result = await Effect.runPromise(provideMockService(program));

      expect(result).toBe(mockResult);
      expect(mockAgentService.listAgents).toHaveBeenCalled();
    });
  });
});
