import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { PersonaService } from "@/core/interfaces/persona-service";
import type { Persona } from "@/core/types/persona";
import { AgentPromptBuilder, type AgentPromptOptions } from "./agent-prompt";

/**
 * The delegatable-agent roster is a per-turn token cost, so these tests lock
 * both halves of the deal: it renders when the agent can actually delegate, and
 * it is absent otherwise.
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

const ROSTER = [
  {
    name: "code-explorer",
    defaultModel: "anthropic/claude-sonnet-4-5",
    whenToUse: "use for tracing call sites",
  },
  { name: "deep-researcher" },
] as const;

function build(options: Partial<AgentPromptOptions>, builder = new AgentPromptBuilder()): string {
  return Effect.runSync(
    builder.buildSystemPrompt(
      "default",
      {
        agentName: "Test",
        agentDescription: "a test agent.",
        userInput: "hello",
        ...options,
      },
      personaServiceReturning("You are {agentName}. Do good work."),
    ),
  );
}

describe("delegatable agent roster injection", () => {
  test("renders the roster when the agent holds spawn_subagent", () => {
    const result = build({
      toolNames: ["read_file", "spawn_subagent"],
      delegatableAgents: [...ROSTER],
    });

    expect(result).toContain("<delegatable_agents>");
    expect(result).toContain(
      "- code-explorer [anthropic/claude-sonnet-4-5]: use for tracing call sites",
    );
    // No model on file: the entry still renders, just without the bracket.
    expect(result).toContain("- deep-researcher");
    expect(result).toContain('agent: "<name>"');
  });

  test("instructs the agent to override the model by task difficulty", () => {
    const result = build({
      toolNames: ["spawn_subagent"],
      delegatableAgents: [...ROSTER],
    });

    expect(result).toContain('model: "provider/model"');
    expect(result).toContain("cheapest model that can actually do the task");
    expect(result).toContain("list_models");
  });

  test("omits the roster when the agent cannot delegate", () => {
    const result = build({
      toolNames: ["read_file"],
      delegatableAgents: [...ROSTER],
    });

    expect(result).not.toContain("<delegatable_agents>");
  });

  test("omits the roster when no agent is marked delegatable", () => {
    const result = build({ toolNames: ["spawn_subagent"], delegatableAgents: [] });

    expect(result).not.toContain("<delegatable_agents>");
  });

  test("a changed roster is not served from the cached prompt", () => {
    const builder = new AgentPromptBuilder();
    const withExplorer = build(
      { toolNames: ["spawn_subagent"], delegatableAgents: [...ROSTER] },
      builder,
    );
    const withoutExplorer = build(
      { toolNames: ["spawn_subagent"], delegatableAgents: [{ name: "deep-researcher" }] },
      builder,
    );

    expect(withExplorer).toContain("code-explorer");
    expect(withoutExplorer).not.toContain("code-explorer");
  });
});
