import { describe, expect, setSystemTime, test } from "bun:test";
import { Effect } from "effect";
import type { PersonaService } from "@/core/interfaces/persona-service";
import { partialFake } from "@/core/test-support/fakes";
import type { Persona } from "@/core/types/persona";
import { AgentPromptBuilder, type AgentPromptOptions } from "./agent-prompt";

/**
 * The environment facts block is injected by the runtime, not authored into each
 * persona file. These tests lock that behavior: grounding personas get the
 * canonical block either injected in place at an `{environment}` token or appended
 * at the end, and the summarizer never receives machine facts.
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
  return partialFake<PersonaService>({
    getPersonaByIdentifier: () => Effect.succeed(persona),
  });
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
    expect(result).toMatch(
      /Environment: Date: .+ \| OS: .+ \| Hardware: .+ \| Shell: .+ \| Home: .+ \| Hostname: .+ \| User: .+ \| TTY: .+/,
    );
    // Live values, not raw placeholders.
    expect(result).not.toContain("{currentDate}");
    expect(result).not.toContain("{osInfo}");
    expect(result).not.toContain("{tty}");
  });

  test("summarizer never receives the environment block", () => {
    const result = build("summarizer", "You are {agentName}, {agentDescription} Summarize.");
    expect(result).not.toContain("Environment:");
    expect(result).not.toContain("Hardware:");
  });

  test("injects the block in place at the {environment} token, before later content, no duplicate", () => {
    const authored = "You are {agentName}.\n\n# Environment\n\n{environment}\n\nDo the work.";
    const result = build("custom", authored);
    expect(result).toContain("Environment: Date:");
    expect(result).not.toContain("{environment}");
    expect(result).not.toContain("{currentDate}");
    // Block sits in place, ahead of the trailing instruction — not appended at the end.
    expect(result.indexOf("Environment: Date:")).toBeLessThan(result.indexOf("Do the work."));
    expect(result.match(/Environment:/g)?.length).toBe(1);
  });

  test("supports individual environment placeholders without duplicating the environment block", () => {
    const result = build("custom", "Today is {currentDate}; user is {username}.");
    expect(result).not.toContain("{currentDate}");
    expect(result).not.toContain("{username}");
    expect(result.match(/Environment:/g)).toBeNull();
  });

  test("agent name and description are always substituted", () => {
    const result = build("default", "You are {agentName}, {agentDescription} Go.");
    expect(result).toContain("You are Test, a test agent.");
    expect(result).not.toContain("{agentName}");
    expect(result).not.toContain("{agentDescription}");
  });
});

test("invalidates the prompt at midnight in its displayed zone", () => {
  const previousZone = process.env["TZ"];
  process.env["TZ"] = "UTC";
  try {
    const builder = new AgentPromptBuilder();
    const service = personaServiceReturning("You are Jazz.");
    const options = { ...OPTIONS, displayTimeZone: "Asia/Tokyo" };
    setSystemTime(new Date("2026-01-01T14:59:00Z"));
    const before = Effect.runSync(builder.buildSystemPrompt("default", options, service));
    setSystemTime(new Date("2026-01-01T15:01:00Z"));
    const after = Effect.runSync(builder.buildSystemPrompt("default", options, service));
    expect(before).toContain("January 1, 2026");
    expect(after).toContain("January 2, 2026");
  } finally {
    setSystemTime();
    if (previousZone === undefined) {
      delete process.env["TZ"];
    } else {
      process.env["TZ"] = previousZone;
    }
  }
});
