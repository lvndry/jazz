import { describe, expect, test } from "bun:test";
import { sortAgents } from "./agent-sort";

describe("sortAgents", () => {
  test("promotes the last-used agent and sorts the rest by name without mutation", () => {
    const agents = [
      { id: "beta", name: "Beta" },
      { id: "alpha", name: "Alpha" },
      { id: "gamma", name: "Gamma" },
    ] as const;

    expect(sortAgents(agents, "gamma").map((agent) => agent.id)).toEqual([
      "gamma",
      "alpha",
      "beta",
    ]);
    expect(agents.map((agent) => agent.id)).toEqual(["beta", "alpha", "gamma"]);
  });
});
