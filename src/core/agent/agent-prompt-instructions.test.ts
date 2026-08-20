import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { PersonaService } from "@/core/interfaces/persona-service";
import type { Persona } from "@/core/types/persona";
import { AgentPromptBuilder, type AgentPromptOptions } from "./agent-prompt";

/**
 * Runtime instruction blocks are injected by the prompt builder, not authored
 * into persona files. These tests lock the gating: every acting persona gets
 * the completion contract, tool guidance only appears when the agent has
 * tools, per-tool notes are filtered to the actual toolset, and the
 * ask_user_question guidance only ships alongside the tool itself.
 */

function personaServiceReturning(systemPrompt: string): PersonaService {
  const persona: Persona = {
    id: "test-id",
    name: "test",
    description: "test persona",
    systemPrompt,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  return {
    getPersonaByIdentifier: () => Effect.succeed(persona),
  } as unknown as PersonaService;
}

function build(personaName: string, options: Partial<AgentPromptOptions> = {}): string {
  const builder = new AgentPromptBuilder();
  const fullOptions: AgentPromptOptions = {
    agentName: "Test",
    agentDescription: "a test agent.",
    userInput: "hello",
    ...options,
  };
  return Effect.runSync(
    builder.buildSystemPrompt(
      personaName,
      fullOptions,
      personaServiceReturning("You are {agentName}."),
    ),
  );
}

describe("completion instructions injection", () => {
  test("acting personas get the completion contract", () => {
    const result = build("default");
    expect(result).toContain("# Seeing work through");
    expect(result).toContain("Never guess a value you can fetch");
    expect(result).toContain("answer from the record");
    expect(result).toContain("Do not stay stuck");
    expect(result).toContain("Do not dump a URL and stop");
    expect(result).toContain("Look up live docs");
  });

  test("summarizer never receives the completion contract", () => {
    const result = build("summarizer");
    expect(result).not.toContain("# Seeing work through");
  });
});

describe("tool guidance injection", () => {
  test("no tool blocks when the agent has no tools", () => {
    const result = build("default");
    expect(result).not.toContain("# Tool usage");
    expect(result).not.toContain("## Tool notes");
    expect(result).not.toContain("# Asking the user questions");
  });

  test("tool selection guidance appears when tools are present", () => {
    const result = build("default", { toolNames: ["http_request"] });
    expect(result).toContain("# Tool usage");
  });

  test("per-tool notes are filtered to the agent's actual toolset", () => {
    const result = build("default", { toolNames: ["http_request", "made_up_tool"] });
    expect(result).toContain("## Tool notes");
    expect(result).toContain("http_request: Body supports 3 types");
    expect(result).not.toContain("grep:");
    expect(result).not.toContain("git workflow");
  });

  test("no notes section when no tool has a note", () => {
    const result = build("default", { toolNames: ["made_up_tool"] });
    expect(result).toContain("# Tool usage");
    expect(result).not.toContain("## Tool notes");
  });

  test("question guidance is gated on ask_user_question", () => {
    const without = build("default", { toolNames: ["http_request"] });
    expect(without).not.toContain("# Asking the user questions");

    const withTool = build("default", { toolNames: ["http_request", "ask_user_question"] });
    expect(withTool).toContain("# Asking the user questions");
    expect(withTool).toContain("Permission to do work the user already requested");
    expect(withTool).toContain("A required CLI or account is not set up");
  });
});

describe("system prompt cache keys off the toolset", () => {
  test("same persona with different tools yields different prompts", () => {
    const builder = new AgentPromptBuilder();
    const service = personaServiceReturning("You are {agentName}.");
    const base: AgentPromptOptions = {
      agentName: "Test",
      agentDescription: "a test agent.",
      userInput: "hello",
    };

    const withQuestions = Effect.runSync(
      builder.buildSystemPrompt("default", { ...base, toolNames: ["ask_user_question"] }, service),
    );
    const withoutQuestions = Effect.runSync(
      builder.buildSystemPrompt("default", { ...base, toolNames: ["http_request"] }, service),
    );

    expect(withQuestions).toContain("# Asking the user questions");
    expect(withoutQuestions).not.toContain("# Asking the user questions");
  });
});
