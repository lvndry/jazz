import { afterEach, describe, expect, test, setSystemTime } from "bun:test";
import { Effect } from "effect";
import type { PersonaService } from "@/core/interfaces/persona-service";
import { partialFake } from "@/core/test-support/fakes";
import type { Persona } from "@/core/types/persona";
import { AgentPromptBuilder, type AgentPromptOptions } from "./agent-prompt";

/**
 * The system prompt starts with text that is identical on every turn of a conversation
 * (persona, harness rules) and continues with text that changes between turns (skills index,
 * AGENTS.md, preferences, the environment block carrying the date). These tests assemble two
 * turns that differ in one live input and show which text moved.
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

const BASE_OPTIONS: AgentPromptOptions = {
  agentName: "Test",
  agentDescription: "a test agent.",
  userInput: "hello",
  toolNames: ["read_file", "execute_command"],
};

function assemble(
  overrides: Partial<AgentPromptOptions>,
  personaPrompt = "You are {agentName}. Do good work.",
) {
  const builder = new AgentPromptBuilder();
  return Effect.runSync(
    builder.buildSystemPromptParts(
      "default",
      { ...BASE_OPTIONS, ...overrides },
      personaServiceReturning(personaPrompt),
    ),
  );
}

function split(rendered: { text: string; stablePrefixLength?: number }): {
  stable: string;
  live: string;
} {
  expect(rendered.stablePrefixLength).toBeDefined();
  return {
    stable: rendered.text.slice(0, rendered.stablePrefixLength),
    live: rendered.text.slice(rendered.stablePrefixLength),
  };
}

afterEach(() => {
  setSystemTime();
});

describe("system prompt stable prefix", () => {
  test("the stable and live parts concatenate to the single prompt", () => {
    const options: Partial<AgentPromptOptions> = {
      activePreferences: [{ scope: "global", summary: "Be brief." }],
    };
    const rendered = assemble(options);
    const { stable, live } = split(rendered);

    expect(stable + live).toBe(rendered.text);
    expect(rendered.text).toBe(
      Effect.runSync(
        new AgentPromptBuilder().buildSystemPrompt(
          "default",
          { ...BASE_OPTIONS, ...options },
          personaServiceReturning("You are {agentName}. Do good work."),
        ),
      ),
    );
  });

  test("the stable part holds persona and harness rules and none of the live inputs", () => {
    const { stable, live } = split(
      assemble({
        knownSkills: [{ name: "deploy", description: "ship it", path: "/skills/deploy" }],
        projectInstructions: [{ path: "/repo/AGENTS.md", content: "Use bun." }],
      }),
    );

    expect(stable).toContain("You are Test. Do good work.");
    expect(stable).toContain("# Jazz harness");
    expect(stable).not.toContain("deploy");
    expect(stable).not.toContain("Use bun.");
    expect(stable).not.toContain("Environment:");
    expect(live).toContain("deploy");
    expect(live).toContain("Use bun.");
    expect(live).toContain("Environment:");
  });

  test("a changed skills index, AGENTS.md or preference moves only the live part", () => {
    const first = split(
      assemble({
        knownSkills: [{ name: "deploy", description: "ship it", path: "/skills/deploy" }],
        projectInstructions: [{ path: "/repo/AGENTS.md", content: "Use bun." }],
      }),
    );
    const secondTurns = [
      assemble({
        knownSkills: [
          { name: "deploy", description: "ship it", path: "/skills/deploy" },
          { name: "review", description: "check it", path: "/skills/review" },
        ],
        projectInstructions: [{ path: "/repo/AGENTS.md", content: "Use bun." }],
      }),
      assemble({
        knownSkills: [{ name: "deploy", description: "ship it", path: "/skills/deploy" }],
        projectInstructions: [{ path: "/repo/AGENTS.md", content: "Use npm." }],
      }),
      assemble({
        knownSkills: [{ name: "deploy", description: "ship it", path: "/skills/deploy" }],
        projectInstructions: [{ path: "/repo/AGENTS.md", content: "Use bun." }],
        activePreferences: [{ scope: "global", summary: "Be brief." }],
      }),
    ];

    for (const turn of secondTurns) {
      const next = split(turn);
      expect(next.stable).toBe(first.stable);
      expect(next.live).not.toBe(first.live);
    }
  });

  test("a new day moves only the live part", () => {
    setSystemTime(new Date("2026-03-01T12:00:00Z"));
    const monday = split(assemble({}));
    setSystemTime(new Date("2026-03-02T12:00:00Z"));
    const tuesday = split(assemble({}));

    expect(tuesday.stable).toBe(monday.stable);
    expect(tuesday.live).not.toBe(monday.live);
  });

  test("a different tool set is a different stable part", () => {
    const withMemory = split(assemble({ toolNames: [...BASE_OPTIONS.toolNames!, "view_memory"] }));
    const without = split(assemble({}));

    expect(withMemory.stable).not.toBe(without.stable);
  });

  test("a persona that places date or host placeholders has no stable part", () => {
    const rendered = assemble({}, "You are {agentName}. Today is {currentDate}.");

    expect(rendered.stablePrefixLength).toBeUndefined();
  });

  test("the summarizer prompt has no live part to split off", () => {
    const rendered = Effect.runSync(
      new AgentPromptBuilder().buildSystemPromptParts(
        "summarizer",
        BASE_OPTIONS,
        personaServiceReturning("Summarize."),
      ),
    );

    expect(rendered.stablePrefixLength).toBeUndefined();
  });
});

describe("system message from buildAgentMessages", () => {
  test("carries the stable prefix length alongside the whole prompt", () => {
    const messages = Effect.runSync(
      new AgentPromptBuilder().buildAgentMessages(
        "default",
        BASE_OPTIONS,
        personaServiceReturning("You are {agentName}."),
      ),
    );
    const system = messages[0];

    expect(system.role).toBe("system");
    expect(system.stablePrefixLength).toBeGreaterThan(0);
    expect(system.stablePrefixLength).toBeLessThan(system.content.length);
  });

  test("a prompt override is sent whole", () => {
    const messages = Effect.runSync(
      new AgentPromptBuilder().buildAgentMessages(
        "default",
        { ...BASE_OPTIONS, systemPromptOverride: "Fixed prompt." },
        personaServiceReturning("You are {agentName}."),
      ),
    );

    expect(messages[0].content).toBe("Fixed prompt.");
    expect(messages[0].stablePrefixLength).toBeUndefined();
  });
});
