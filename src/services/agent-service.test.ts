import { describe, expect, it, mock } from "bun:test";
import { Effect } from "effect";
import { AgentServiceImpl } from "./agent-service";
import { type StorageService } from "../core/interfaces/storage";
import {
  AgentAlreadyExistsError,
  StorageNotFoundError,
  ValidationError,
} from "../core/types/errors";
import { type Agent } from "../core/types/index";

// Mock Storage Service
const mockStorage = {
  listAgents: mock(() => Effect.succeed([])),
  saveAgent: mock(() => Effect.void),
  getAgent: mock(() => Effect.fail(new StorageNotFoundError({ path: "none" }))),
  deleteAgent: mock(() => Effect.void),
} as unknown as StorageService;

describe("AgentService", () => {
  const service = new AgentServiceImpl(mockStorage);

  describe("createAgent", () => {
    it("should create an agent with default config", async () => {
      // @ts-expect-error - mocking
      mockStorage.listAgents.mockReturnValueOnce(Effect.succeed([]));
      // @ts-expect-error - mocking
      mockStorage.saveAgent.mockReturnValueOnce(Effect.void);

      const program = service.createAgent("test-agent", "A test agent");
      const result = await Effect.runPromise(program);

      expect(result.name).toBe("test-agent");
      expect(result.description).toBe("A test agent");
      expect(result.config.agentType).toBe("default");
      expect(result.config.llmProvider).toBe("openai");
      expect(mockStorage.saveAgent).toHaveBeenCalled();
    });

    it("should fail if agent name is invalid", async () => {
      const program = service.createAgent("Invalid Name!", "Description");
      const result = await Effect.runPromiseExit(program);

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.cause._tag).toBe("Fail");
        // @ts-expect-error - accessing error
        expect(result.cause.error).toBeInstanceOf(ValidationError);
      }
    });

    it("should fail if agent name already exists", async () => {
      // @ts-expect-error - mocking
      mockStorage.listAgents.mockReturnValueOnce(
        Effect.succeed([{ name: "existing-agent" } as Agent]),
      );

      const program = service.createAgent("existing-agent", "Description");
      const result = await Effect.runPromiseExit(program);

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.cause._tag).toBe("Fail");
        // @ts-expect-error - accessing error
        expect(result.cause.error).toBeInstanceOf(AgentAlreadyExistsError);
      }
    });
  });

  describe("updateAgent", () => {
    it("should update an existing agent", async () => {
      const existingAgent: Agent = {
        id: "id-1",
        name: "old-name",
        config: { agentType: "default", llmProvider: "openai", llmModel: "gpt-4" },
        createdAt: new Date(),
        updatedAt: new Date(),
        model: "openai/gpt-4",
      };

      // @ts-expect-error - mocking
      mockStorage.getAgent.mockReturnValueOnce(Effect.succeed(existingAgent));
      // @ts-expect-error - mocking
      mockStorage.listAgents.mockReturnValueOnce(Effect.succeed([existingAgent]));
      // @ts-expect-error - mocking
      mockStorage.saveAgent.mockReturnValueOnce(Effect.void);

      const program = service.updateAgent("id-1", { name: "new-name" });
      const result = await Effect.runPromise(program);

      expect(result.name).toBe("new-name");
      expect(result.id).toBe("id-1");
      expect(mockStorage.saveAgent).toHaveBeenCalled();
    });

    it("should fail if updating to an existing name", async () => {
      const agent1: Agent = { id: "1", name: "agent1" } as unknown as Agent;
      const agent2: Agent = { id: "2", name: "agent2" } as unknown as Agent;

      // @ts-expect-error - mocking
      mockStorage.getAgent.mockReturnValueOnce(Effect.succeed(agent1));
      // @ts-expect-error - mocking
      mockStorage.listAgents.mockReturnValueOnce(Effect.succeed([agent1, agent2]));

      const program = service.updateAgent("1", { name: "agent2" });
      const result = await Effect.runPromiseExit(program);

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        // @ts-expect-error - accessing error
        expect(result.cause.error).toBeInstanceOf(AgentAlreadyExistsError);
      }
    });
  });

  describe("deleteAgent", () => {
    it("should delete an agent", async () => {
      // @ts-expect-error - mocking
      mockStorage.deleteAgent.mockReturnValueOnce(Effect.void);

      const program = service.deleteAgent("id-1");
      await Effect.runPromise(program);

      expect(mockStorage.deleteAgent).toHaveBeenCalledWith("id-1");
    });
  });
});
