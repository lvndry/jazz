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

function personaServiceReturning(
  systemPrompt: string,
  voice: { tone?: string; style?: string } = {},
): PersonaService {
  const persona: Persona = {
    id: "test-id",
    name: "test",
    description: "test persona",
    systemPrompt,
    ...voice,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  return {
    getPersonaByIdentifier: () => Effect.succeed(persona),
  } as unknown as PersonaService;
}

function build(
  personaName: string,
  options: Partial<AgentPromptOptions> = {},
  voice: { tone?: string; style?: string } = {},
): string {
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
      personaServiceReturning("You are {agentName}.", voice),
    ),
  );
}

describe("completion instructions injection", () => {
  test("acting personas get the completion contract", () => {
    const result = build("default");
    expect(result).toContain("# Jazz harness");
    expect(result).toContain("## Operating rules");
    expect(result).toContain("Never guess what a tool can fetch");
    expect(result).toContain("from the actual record");
    expect(result).toContain("Do not stay stuck");
    expect(result).toContain("Do not dump a URL and stop");
    expect(result).toContain("inspect current documentation");
    expect(result).toContain("larger follow-up job");
    expect(result).not.toContain("brief offer of optional follow-up");
  });

  test("summarizer never receives the completion contract", () => {
    const result = build("summarizer");
    expect(result).not.toContain("# Jazz harness");
  });
});

describe("tool guidance injection", () => {
  test("no tool blocks when the agent has no tools", () => {
    const result = build("default");
    expect(result).not.toContain("## Tools");
    expect(result).not.toContain("# Asking the user questions");
  });

  test("tool selection guidance appears when tools are present", () => {
    const result = build("default", { toolNames: ["http_request"] });
    expect(result).toContain("## Tools");
    expect(result).toContain("prefer the most specific available tool");
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
    expect(result).toContain("playbook: follow it");
    expect(result).toContain("without asking first");
    expect(result).toContain("shorter workflow");
    expect(result).not.toContain("Follow the loaded skill's step-by-step workflow");
  });
});

describe("deferred tools index", () => {
  test("no deferred-tools block when there are none", () => {
    const result = build("default");
    expect(result).not.toContain("<deferred_tools>");
  });

  test("deferred tools render as a name/summary index, not a schema", () => {
    const result = build("default", {
      deferredTools: [{ name: "linear_create_issue", summary: "Create a Linear issue." }],
    });
    expect(result).toContain("<deferred_tools>");
    expect(result).toContain("- linear_create_issue: Create a Linear issue.");
    expect(result).toContain("call search_tools");
    expect(result).toContain("Do not call a deferred");
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
