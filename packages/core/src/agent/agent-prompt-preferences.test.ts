import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { PersonaService } from "@/core/interfaces/persona-service";
import type { Persona } from "@/core/types/persona";
import { AgentPromptBuilder, type AgentPromptOptions } from "./agent-prompt";

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

describe("active preferences in the system prompt", () => {
  test("adds no section when nothing is in force", () => {
    const result = build(new AgentPromptBuilder(), BASE_OPTIONS);
    expect(result).not.toContain("## Preferences");
  });

  test("renders each entry tagged with the scope it came from", () => {
    const result = build(new AgentPromptBuilder(), {
      ...BASE_OPTIONS,
      activePreferences: [
        { scope: "personal", summary: "prefers concise replies" },
        { scope: "work", summary: "sign emails with the team name" },
      ],
    });

    expect(result).toContain("## Preferences");
    expect(result).toContain("- [personal] prefers concise replies");
    expect(result).toContain("- [work] sign emails with the team name");
  });

  test("the same summary from a different scope invalidates the cached prompt", () => {
    const builder = new AgentPromptBuilder();

    const before = build(builder, {
      ...BASE_OPTIONS,
      activePreferences: [{ scope: "personal", summary: "prefers concise replies" }],
    });
    const after = build(builder, {
      ...BASE_OPTIONS,
      activePreferences: [{ scope: "work", summary: "prefers concise replies" }],
    });

    expect(before).toContain("[personal]");
    expect(after).toContain("[work]");
    expect(after).not.toContain("[personal]");
  });
});
