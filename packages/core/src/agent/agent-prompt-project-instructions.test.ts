import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { PersonaService } from "@/core/interfaces/persona-service";
import type { Persona } from "@/core/types/persona";
import { AgentPromptBuilder, type AgentPromptOptions } from "./agent-prompt";

/**
 * AGENTS.md files reach the model through the system prompt. These tests lock
 * the contract the prompt builder owns: the files are rendered verbatim, the
 * nearest one lands last, and editing a file invalidates the prompt cache.
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

const BASE_OPTIONS: AgentPromptOptions = {
  agentName: "Test",
  agentDescription: "a test agent.",
  userInput: "hello",
};

function build(builder: AgentPromptBuilder, options: AgentPromptOptions): string {
  return Effect.runSync(
    builder.buildSystemPrompt("default", options, personaServiceReturning("You are {agentName}.")),
  );
}

describe("project instructions in the system prompt", () => {
  test("adds no section when no AGENTS.md was found", () => {
    const result = build(new AgentPromptBuilder(), BASE_OPTIONS);
    expect(result).not.toContain("<project_instructions>");
  });

  test("renders discovered files verbatim, nearest last", () => {
    const result = build(new AgentPromptBuilder(), {
      ...BASE_OPTIONS,
      projectInstructions: [
        { path: "/repo/AGENTS.md", content: "Run tests with bun test." },
        { path: "/repo/web/AGENTS.md", content: "Web package uses pnpm." },
      ],
    });

    expect(result).toContain("<project_instructions>");
    expect(result).toContain("Run tests with bun test.");
    expect(result).toContain("Web package uses pnpm.");
    expect(result.indexOf("Run tests with bun test.")).toBeLessThan(
      result.indexOf("Web package uses pnpm."),
    );
  });

  test("editing an AGENTS.md invalidates the cached prompt", () => {
    const builder = new AgentPromptBuilder();

    const before = build(builder, {
      ...BASE_OPTIONS,
      projectInstructions: [{ path: "/repo/AGENTS.md", content: "old rule" }],
    });
    const after = build(builder, {
      ...BASE_OPTIONS,
      projectInstructions: [{ path: "/repo/AGENTS.md", content: "new rule" }],
    });

    expect(before).toContain("old rule");
    expect(after).toContain("new rule");
    expect(after).not.toContain("old rule");
  });
});
