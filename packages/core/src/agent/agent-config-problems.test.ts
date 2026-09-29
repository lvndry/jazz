import { describe, expect, it } from "bun:test";
import type { Agent } from "@/core/types/index";
import { agentConfigProblems } from "./agent-config-problems";

function agent(config: Partial<Agent["config"]>): Agent {
  return {
    id: "a",
    name: "a",
    config: {
      persona: "default",
      llm: { provider: "openai", model: "gpt-5" },
      tools: [],
      ...config,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Agent;
}

describe("agentConfigProblems", () => {
  it("finds nothing wrong with a sound agent", () => {
    expect(
      agentConfigProblems(
        agent({
          llm: { provider: "openai", model: "gpt-5.4", reasoning: "high" },
          tools: ["read_file"],
        }),
        new Set(["read_file"]),
      ),
    ).toEqual([]);
  });

  it("flags a misspelled provider and an unknown reasoning level as errors", () => {
    const problems = agentConfigProblems(
      agent({
        llm: { provider: "opneai" as never, model: "gpt-5.4", reasoning: "extreme" as never },
      }),
    );
    expect(problems.map((problem) => [problem.field, problem.severity])).toEqual([
      ["config.llm.provider", "error"],
      ["config.llm.reasoning", "error"],
    ]);
    expect(problems[0]?.message).toContain('"openai"');
  });

  it("warns about a tool nothing built in provides, but not about MCP tools", () => {
    const problems = agentConfigProblems(
      agent({ tools: ["read_fille", "mcp_linear_list_issues"] }),
      new Set(["read_file"]),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]?.severity).toBe("warning");
    expect(problems[0]?.message).toContain('Did you mean "read_file"?');
  });
});
