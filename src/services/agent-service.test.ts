import { describe, expect, it, mock } from "bun:test";
import { Effect } from "effect";
import { AgentServiceImpl } from "./agent-service";
import { type StorageService } from "../core/interfaces/storage";
import {
  AgentAlreadyExistsError,
  AgentConfigurationError,
  StorageNotFoundError,
  ValidationError,
} from "../core/types/errors";
import { type Agent, type AgentConfig } from "../core/types/index";

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
      expect(result.config.persona).toBe("default");
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
        config: { persona: "default", llmProvider: "openai", llmModel: "gpt-4" },
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

  describe("validateAgentConfig envAllowlist", () => {
    const baseConfig: AgentConfig = {
      persona: "default",
      llmProvider: "openai",
      llmModel: "gpt-4",
    };

    it("accepts well-formed allowlist names", async () => {
      const program = service.validateAgentConfig({
        ...baseConfig,
        envAllowlist: ["MY_TOKEN", "A", "SOME_LONG_NAME_2"],
      });

      await expect(Effect.runPromise(program)).resolves.toBeUndefined();
    });

    it("rejects a name that does not start with an uppercase letter", async () => {
      const program = service.validateAgentConfig({
        ...baseConfig,
        envAllowlist: ["1BAD_NAME"],
      });

      const result = await Effect.runPromiseExit(program);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        // @ts-expect-error - accessing error
        expect(result.cause.error).toBeInstanceOf(AgentConfigurationError);
      }
    });

    it("rejects a lowercase name", async () => {
      const program = service.validateAgentConfig({
        ...baseConfig,
        envAllowlist: ["my_token"],
      });

      const result = await Effect.runPromiseExit(program);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        // @ts-expect-error - accessing error
        expect(result.cause.error).toBeInstanceOf(AgentConfigurationError);
      }
    });

    it("rejects a name longer than 64 characters", async () => {
      const program = service.validateAgentConfig({
        ...baseConfig,
        envAllowlist: [`A${"B".repeat(64)}`],
      });

      const result = await Effect.runPromiseExit(program);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        // @ts-expect-error - accessing error
        expect(result.cause.error).toBeInstanceOf(AgentConfigurationError);
      }
    });

    it("rejects more than 32 allowlist names", async () => {
      const program = service.validateAgentConfig({
        ...baseConfig,
        envAllowlist: Array.from({ length: 33 }, (_unused, index) => `VAR_${index}`),
      });

      const result = await Effect.runPromiseExit(program);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        // @ts-expect-error - accessing error
        expect(result.cause.error).toBeInstanceOf(AgentConfigurationError);
      }
    });
  });

  describe("validateAgentConfig customTools", () => {
    const baseConfig: AgentConfig = {
      persona: "default",
      llmProvider: "openai",
      llmModel: "gpt-4",
    };

    it("accepts a valid record-handler tool", async () => {
      const program = service.validateAgentConfig({
        ...baseConfig,
        customTools: [
          {
            name: "ping",
            description: "Responds with a fixed pong message.",
            parameters: { type: "object", properties: {} },
            handler: { type: "record", response: "pong" },
          },
        ],
      });

      await expect(Effect.runPromise(program)).resolves.toBeUndefined();
    });

    it("accepts a valid command-handler tool", async () => {
      const program = service.validateAgentConfig({
        ...baseConfig,
        customTools: [
          {
            name: "list_files",
            description: "Lists files in the current directory.",
            parameters: { type: "object", properties: {} },
            handler: { type: "command", command: ["ls", "-la"], timeoutMs: 5000 },
          },
        ],
      });

      await expect(Effect.runPromise(program)).resolves.toBeUndefined();
    });

    it("rejects more than 16 custom tools", async () => {
      const program = service.validateAgentConfig({
        ...baseConfig,
        customTools: Array.from({ length: 17 }, (_unused, index) => ({
          name: `tool_${index}`,
          description: "A tool.",
          parameters: { type: "object", properties: {} },
          handler: { type: "record" as const, response: "ok" },
        })),
      });

      const result = await Effect.runPromiseExit(program);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        // @ts-expect-error - accessing error
        expect(result.cause.error).toBeInstanceOf(AgentConfigurationError);
      }
    });

    it("rejects a non-array customTools value", async () => {
      const program = service.validateAgentConfig({
        ...baseConfig,
        // @ts-expect-error - testing invalid input shape
        customTools: { name: "not-an-array" },
      });

      const result = await Effect.runPromiseExit(program);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        // @ts-expect-error - accessing error
        expect(result.cause.error).toBeInstanceOf(AgentConfigurationError);
      }
    });

    it("rejects a name that does not match the required pattern", async () => {
      const program = service.validateAgentConfig({
        ...baseConfig,
        customTools: [
          {
            name: "Ping",
            description: "Bad name casing.",
            parameters: { type: "object", properties: {} },
            handler: { type: "record", response: "pong" },
          },
        ],
      });

      const result = await Effect.runPromiseExit(program);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        // @ts-expect-error - accessing error
        expect(result.cause.error).toBeInstanceOf(AgentConfigurationError);
      }
    });

    it("rejects a name starting with mcp_", async () => {
      const program = service.validateAgentConfig({
        ...baseConfig,
        customTools: [
          {
            name: "mcp_something",
            description: "Reserved prefix.",
            parameters: { type: "object", properties: {} },
            handler: { type: "record", response: "pong" },
          },
        ],
      });

      const result = await Effect.runPromiseExit(program);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        // @ts-expect-error - accessing error
        expect(result.cause.error).toBeInstanceOf(AgentConfigurationError);
      }
    });

    it("rejects duplicate names within the array", async () => {
      const program = service.validateAgentConfig({
        ...baseConfig,
        customTools: [
          {
            name: "ping",
            description: "First.",
            parameters: { type: "object", properties: {} },
            handler: { type: "record", response: "pong" },
          },
          {
            name: "ping",
            description: "Second.",
            parameters: { type: "object", properties: {} },
            handler: { type: "record", response: "pong2" },
          },
        ],
      });

      const result = await Effect.runPromiseExit(program);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        // @ts-expect-error - accessing error
        expect(result.cause.error).toBeInstanceOf(AgentConfigurationError);
      }
    });

    it("rejects a description that is empty", async () => {
      const program = service.validateAgentConfig({
        ...baseConfig,
        customTools: [
          {
            name: "ping",
            description: "",
            parameters: { type: "object", properties: {} },
            handler: { type: "record", response: "pong" },
          },
        ],
      });

      const result = await Effect.runPromiseExit(program);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        // @ts-expect-error - accessing error
        expect(result.cause.error).toBeInstanceOf(AgentConfigurationError);
      }
    });

    it("rejects a description longer than 1024 characters", async () => {
      const program = service.validateAgentConfig({
        ...baseConfig,
        customTools: [
          {
            name: "ping",
            description: "A".repeat(1025),
            parameters: { type: "object", properties: {} },
            handler: { type: "record", response: "pong" },
          },
        ],
      });

      const result = await Effect.runPromiseExit(program);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        // @ts-expect-error - accessing error
        expect(result.cause.error).toBeInstanceOf(AgentConfigurationError);
      }
    });

    it("rejects parameters that are not a plain object", async () => {
      const program = service.validateAgentConfig({
        ...baseConfig,
        customTools: [
          {
            name: "ping",
            description: "Bad parameters.",
            // @ts-expect-error - testing invalid input shape
            parameters: null,
            handler: { type: "record", response: "pong" },
          },
        ],
      });

      const result = await Effect.runPromiseExit(program);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        // @ts-expect-error - accessing error
        expect(result.cause.error).toBeInstanceOf(AgentConfigurationError);
      }
    });

    it('rejects parameters whose type is not "object"', async () => {
      const program = service.validateAgentConfig({
        ...baseConfig,
        customTools: [
          {
            name: "ping",
            description: "Bad parameters type.",
            parameters: { type: "string" },
            handler: { type: "record", response: "pong" },
          },
        ],
      });

      const result = await Effect.runPromiseExit(program);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        // @ts-expect-error - accessing error
        expect(result.cause.error).toBeInstanceOf(AgentConfigurationError);
      }
    });

    it("rejects an unknown handler type", async () => {
      const program = service.validateAgentConfig({
        ...baseConfig,
        customTools: [
          {
            name: "ping",
            description: "Bad handler type.",
            parameters: { type: "object", properties: {} },
            // @ts-expect-error - testing invalid input shape
            handler: { type: "bogus" },
          },
        ],
      });

      const result = await Effect.runPromiseExit(program);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        // @ts-expect-error - accessing error
        expect(result.cause.error).toBeInstanceOf(AgentConfigurationError);
      }
    });

    it("rejects a record response longer than 1024 characters", async () => {
      const program = service.validateAgentConfig({
        ...baseConfig,
        customTools: [
          {
            name: "ping",
            description: "Oversized response.",
            parameters: { type: "object", properties: {} },
            handler: { type: "record", response: "A".repeat(1025) },
          },
        ],
      });

      const result = await Effect.runPromiseExit(program);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        // @ts-expect-error - accessing error
        expect(result.cause.error).toBeInstanceOf(AgentConfigurationError);
      }
    });

    it("rejects a command handler with an empty command array", async () => {
      const program = service.validateAgentConfig({
        ...baseConfig,
        customTools: [
          {
            name: "list_files",
            description: "Empty command.",
            parameters: { type: "object", properties: {} },
            handler: { type: "command", command: [] },
          },
        ],
      });

      const result = await Effect.runPromiseExit(program);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        // @ts-expect-error - accessing error
        expect(result.cause.error).toBeInstanceOf(AgentConfigurationError);
      }
    });

    it("rejects a command handler with an empty string entry", async () => {
      const program = service.validateAgentConfig({
        ...baseConfig,
        customTools: [
          {
            name: "list_files",
            description: "Empty entry in command.",
            parameters: { type: "object", properties: {} },
            handler: { type: "command", command: ["ls", ""] },
          },
        ],
      });

      const result = await Effect.runPromiseExit(program);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        // @ts-expect-error - accessing error
        expect(result.cause.error).toBeInstanceOf(AgentConfigurationError);
      }
    });

    it("rejects a timeoutMs that is not a positive integer", async () => {
      const program = service.validateAgentConfig({
        ...baseConfig,
        customTools: [
          {
            name: "list_files",
            description: "Bad timeout.",
            parameters: { type: "object", properties: {} },
            handler: { type: "command", command: ["ls"], timeoutMs: 0 },
          },
        ],
      });

      const result = await Effect.runPromiseExit(program);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        // @ts-expect-error - accessing error
        expect(result.cause.error).toBeInstanceOf(AgentConfigurationError);
      }
    });

    it("rejects a timeoutMs greater than 300_000", async () => {
      const program = service.validateAgentConfig({
        ...baseConfig,
        customTools: [
          {
            name: "list_files",
            description: "Timeout too large.",
            parameters: { type: "object", properties: {} },
            handler: { type: "command", command: ["ls"], timeoutMs: 300_001 },
          },
        ],
      });

      const result = await Effect.runPromiseExit(program);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        // @ts-expect-error - accessing error
        expect(result.cause.error).toBeInstanceOf(AgentConfigurationError);
      }
    });
  });

  describe("validateAgentConfig summarizerModel", () => {
    const baseConfig: AgentConfig = {
      persona: "default",
      llmProvider: "openai",
      llmModel: "gpt-4",
    };

    it("accepts a valid summarizerModel", async () => {
      const program = service.validateAgentConfig({
        ...baseConfig,
        summarizerModel: "anthropic/claude-3-5-haiku-latest",
      });
      await expect(Effect.runPromise(program)).resolves.toBeUndefined();
    });

    it("accepts config with no summarizerModel", async () => {
      const program = service.validateAgentConfig(baseConfig);
      await expect(Effect.runPromise(program)).resolves.toBeUndefined();
    });

    it("accepts a null summarizerModel as a cleared field", async () => {
      const program = service.validateAgentConfig({
        ...baseConfig,
        summarizerModel: null as unknown as string,
      });
      await expect(Effect.runPromise(program)).resolves.toBeUndefined();
    });

    it("rejects a summarizerModel with no slash", async () => {
      const program = service.validateAgentConfig({
        ...baseConfig,
        summarizerModel: "gpt-4",
      });
      const result = await Effect.runPromiseExit(program);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        // @ts-expect-error - accessing error
        expect(result.cause.error).toBeInstanceOf(AgentConfigurationError);
      }
    });

    it("rejects a summarizerModel with an unknown provider", async () => {
      const program = service.validateAgentConfig({
        ...baseConfig,
        summarizerModel: "notaprovider/some-model",
      });
      const result = await Effect.runPromiseExit(program);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        // @ts-expect-error - accessing error
        expect(result.cause.error).toBeInstanceOf(AgentConfigurationError);
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
