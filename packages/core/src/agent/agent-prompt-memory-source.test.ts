import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { PersonaService } from "@/core/interfaces/persona-service";
import type { Persona } from "@/core/types/persona";
import { AgentPromptBuilder, type AgentPromptOptions } from "./agent-prompt";

const persona: Persona = {
  id: "test-id",
  name: "test",
  description: "test persona",
  systemPrompt: "You are {agentName}.",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const personaService = {
  getPersonaByIdentifier: () => Effect.succeed(persona),
} as unknown as PersonaService;

const memorySource = { id: "user:run-1", text: "My favorite fruit is mango." };

function lastUserMessage(options: AgentPromptOptions) {
  const messages = Effect.runSync(
    new AgentPromptBuilder().buildAgentMessages("default", options, personaService),
  );
  return messages.filter((message) => message.role === "user").at(-1);
}

describe("memory source tag on the user message", () => {
  test("tags a quotable message only for an agent that can write memory", () => {
    const base: AgentPromptOptions = {
      agentName: "Test",
      agentDescription: "a test agent.",
      userInput: memorySource.text,
      memorySource,
    };

    const withTool = lastUserMessage({ ...base, toolNames: ["manage_memory"] });
    expect(withTool?.content).toContain("[memory source user:run-1]");
    expect(withTool?.memorySource).toEqual(memorySource);

    const withoutTool = lastUserMessage({ ...base, toolNames: ["read_file"] });
    expect(withoutTool?.content).not.toContain("[memory source");
    expect(withoutTool?.memorySource).toEqual(memorySource);
  });
});
