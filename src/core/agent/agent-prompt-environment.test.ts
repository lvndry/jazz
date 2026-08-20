import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { PersonaService } from "@/core/interfaces/persona-service";
import type { Persona } from "@/core/types/persona";
import { AgentPromptBuilder, type AgentPromptOptions } from "./agent-prompt";

/**
 * The environment facts block is injected by the runtime, not authored into each
 * persona file. These tests lock that behavior: grounding personas get the
 * canonical block appended with live values, a persona that hand-places
 * {currentDate} keeps in-place control with no duplicate block, and the
 * summarizer never receives machine facts.
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

const OPTIONS: AgentPromptOptions = {
  agentName: "Test",
  agentDescription: "a test agent.",
  userInput: "hello",
};

function build(personaName: string, systemPrompt: string): string {
  const builder = new AgentPromptBuilder();
  return Effect.runSync(
    builder.buildSystemPrompt(personaName, OPTIONS, personaServiceReturning(systemPrompt)),
  );
}

describe("environment block injection", () => {
  test("appends the canonical block with live values when no placeholder is authored", () => {
    const result = build("default", "You are {agentName}. Do good work.");
    expect(result).toContain("# Environment");
    expect(result).toContain("- Date:");
    expect(result).toContain("- Hardware:");
    expect(result).toContain("- Hostname:");
    expect(result).toContain("- TTY:");
    expect(result).toContain("- Session: unattended");
    // Live values, not raw placeholders.
    expect(result).not.toContain("{currentDate}");
    expect(result).not.toContain("{osInfo}");
    expect(result).not.toContain("{tty}");
    expect(result).not.toContain("{session}");
  });

  test("session interactive is injected when passed on the options", () => {
    const builder = new AgentPromptBuilder();
    const result = Effect.runSync(
      builder.buildSystemPrompt(
        "default",
        { ...OPTIONS, session: "interactive" },
        personaServiceReturning("You are {agentName}."),
      ),
    );
    expect(result).toContain("- Session: interactive");
    expect(result).not.toContain("- Session: unattended");
  });

  test("interactive and unattended sessions do not share a cached prompt", () => {
    const builder = new AgentPromptBuilder();
    const service = personaServiceReturning("You are {agentName}.");
    const interactive = Effect.runSync(
      builder.buildSystemPrompt("default", { ...OPTIONS, session: "interactive" }, service),
    );
    const unattended = Effect.runSync(
      builder.buildSystemPrompt("default", { ...OPTIONS, session: "unattended" }, service),
    );
    expect(interactive).toContain("- Session: interactive");
    expect(unattended).toContain("- Session: unattended");
  });

  test("substitutes in place and adds no second block when persona hand-places the block", () => {
    const authored = "You are {agentName}.\n\n# Environment\n\n- Date: {currentDate}\n";
    const result = build("custom", authored);
    expect(result).not.toContain("{currentDate}");
    // Exactly one Environment heading — the hand-placed one, not a duplicate.
    expect(result.match(/# Environment/g)?.length).toBe(1);
  });

  test("summarizer never receives the environment block", () => {
    const result = build("summarizer", "You are {agentName}, {agentDescription} Summarize.");
    expect(result).not.toContain("# Environment");
    expect(result).not.toContain("- Hardware:");
  });

  test("agent name and description are always substituted", () => {
    const result = build("default", "You are {agentName}, {agentDescription} Go.");
    expect(result).toContain("You are Test, a test agent.");
    expect(result).not.toContain("{agentName}");
    expect(result).not.toContain("{agentDescription}");
  });
});
