import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { PersonaService } from "@/core/interfaces/persona-service";
import type { Persona } from "@/core/types/persona";
import { AgentPromptBuilder, type AgentPromptOptions } from "./agent-prompt";

/**
 * Runtime instruction blocks are injected by the prompt builder, not authored
 * into persona files. These tests lock the gating: every acting persona gets
 * the completion contract, tool guidance only appears when the agent has
 * tools, and the interactive-question guidance only ships alongside
 * ask_user_question or ask_file_picker.
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
    expect(result).toContain("Do not invent a larger next job");
    expect(result).not.toContain("brief offer of optional follow-up");
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
    expect(result).not.toContain("# Asking the user questions");
  });

  test("tool selection guidance appears when tools are present", () => {
    const result = build("default", { toolNames: ["http_request"] });
    expect(result).toContain("# Tool usage");
    expect(result).toContain("execute its playbook");
  });
});

describe("skills playbook instructions", () => {
  test("loaded skills are the playbook, not a suggestion", () => {
    const result = build("default", {
      knownSkills: [
        {
          name: "pr-description",
          description: "Draft a PR body from the branch diff.",
          path: "/skills/pr-description",
        },
      ],
    });
    expect(result).toContain("A loaded skill is the playbook");
    expect(result).toContain("Do not ask whether to follow it");
    expect(result).toContain("do not substitute a shorter path");
    expect(result).not.toContain("Follow the loaded skill's step-by-step workflow");
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

describe("media generation guidance", () => {
  test("a model that cannot generate media is told how to redirect the user", () => {
    // Without this the agent answers "I can't generate images" and stops, which is true and a
    // dead end — jazz has no generation tool, so the only route is another agent.
    const prompt = build("default", { canGenerateMedia: false });
    expect(prompt).toContain("jazz agent list --can image");
  });

  test("a model that can generate media is not given it", () => {
    const prompt = build("default", { canGenerateMedia: true });
    expect(prompt).not.toContain("jazz agent list --can image");
  });

  test("nothing is added when the capability is unknown", () => {
    // Absent metadata should not put instructions in every prompt; the guidance is opt-in on a
    // definite "cannot".
    expect(build("default")).not.toContain("jazz agent list --can image");
  });

  test("the summarizer never gets it — no user to advise", () => {
    expect(build("summarizer", { canGenerateMedia: false })).not.toContain("jazz agent list");
  });
});
