import { describe, expect, it, vi } from "bun:test";
import { Effect, Layer } from "effect";
import { TerminalServiceTag, type TerminalService } from "@/core/interfaces/terminal";
import {
  AgentAlreadyExistsError,
  AgentNotFoundError,
  ConfigurationError,
  ValidationError,
} from "@/core/types/errors";
import { formatError, handleError } from "./error-handler";

describe("Error Handler", () => {
  it("should format AgentNotFoundError with actionable suggestions", () => {
    const error = new AgentNotFoundError({
      agentId: "non-existent-agent",
      suggestion: "Check if the agent ID is correct or if the agent was deleted",
    });

    const formatted = formatError(error);

    expect(formatted).toContain("❌ Agent Not Found");
    expect(formatted).toContain("No agent found with ID: non-existent-agent");
    expect(formatted).toContain("💡 Suggestion:");
    expect(formatted).toContain("🔧 Recovery Steps:");
    expect(formatted).toContain("jazz agent list");
    expect(formatted).toContain("jazz agent create");
  });

  it("should format AgentAlreadyExistsError with suggestions", () => {
    const error = new AgentAlreadyExistsError({
      agentId: "duplicate-agent",
    });

    const formatted = formatError(error);

    expect(formatted).toContain("❌ Agent Already Exists");
    expect(formatted).toContain('An agent with name "duplicate-agent" already exists');
    expect(formatted).toContain("jazz agent delete");
    expect(formatted).toContain("jazz agent list");
  });

  it("should format ValidationError with field-specific suggestions", () => {
    const error = new ValidationError({
      field: "name",
      message: "Agent name can only contain letters, numbers, underscores, and hyphens",
      value: "invalid@name",
      suggestion:
        "Use only letters (a-z, A-Z), numbers (0-9), underscores (_), and hyphens (-). Example: 'my-agent-1'",
    });

    const formatted = formatError(error);

    expect(formatted).toContain("❌ Validation Error");
    expect(formatted).toContain('Field "name" validation failed');
    expect(formatted).toContain("💡 Suggestion:");
    expect(formatted).toContain("my-agent-1");
  });

  it("should format ConfigurationError with recovery steps", () => {
    const error = new ConfigurationError({
      field: "llm.openai.api_key",
      message: "API key is required",
      value: undefined,
      suggestion: "Set your OpenAI API key in the configuration",
    });

    const formatted = formatError(error);

    expect(formatted).toContain("❌ Configuration Error");
    expect(formatted).toContain('Configuration error in field "llm.openai.api_key"');
    expect(formatted).toContain("🔧 Recovery Steps:");
    expect(formatted).toContain("jazz config list");
    expect(formatted).toContain("jazz config validate");
  });

  it("should handle error display without crashing", async () => {
    const error = new AgentNotFoundError({
      agentId: "test-agent",
    });

    const mockTerminalService: TerminalService = {
      info: vi.fn().mockReturnValue(Effect.void),
      success: vi.fn().mockReturnValue(Effect.void),
      error: vi.fn().mockReturnValue(Effect.void),
      warn: vi.fn().mockReturnValue(Effect.void),
      log: vi.fn().mockReturnValue(Effect.void),
      debug: vi.fn().mockReturnValue(Effect.void),
      heading: vi.fn().mockReturnValue(Effect.void),
      list: vi.fn().mockReturnValue(Effect.void),
      ask: vi.fn().mockReturnValue(Effect.succeed("")),
      password: vi.fn().mockReturnValue(Effect.succeed("")),
      select: vi.fn().mockReturnValue(Effect.succeed("")),
      confirm: vi.fn().mockReturnValue(Effect.succeed(true)),
      search: vi.fn().mockReturnValue(Effect.succeed("")),
      checkbox: vi.fn().mockReturnValue(Effect.succeed([])),
    };

    const terminalLayer = Layer.succeed(TerminalServiceTag, mockTerminalService);

    // This should not throw
    await Effect.runPromise(handleError(error).pipe(Effect.provide(terminalLayer)));
  });

  it("should provide related commands for different error types", () => {
    const errors = [
      new AgentNotFoundError({ agentId: "test" }),
      new ValidationError({ field: "name", message: "Invalid", value: "test" }),
      new ConfigurationError({ field: "api_key", message: "Missing", value: undefined }),
    ];

    errors.forEach((error) => {
      const formatted = formatError(error);
      expect(formatted).toContain("📚 Related Commands:");
      expect(formatted).toContain("jazz");
    });
  });
});
