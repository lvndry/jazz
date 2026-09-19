/** Regression tests for the routing corpus and deterministic lexical report. */
import { describe, expect, it } from "bun:test";
import { skillRoutingCases } from "./dataset";
import { runLexicalRoutingBenchmark } from "./runner";

describe("skill-routing component benchmark", () => {
  it("keeps the promised corpus shape", () => {
    expect(skillRoutingCases).toHaveLength(120);
    expect(skillRoutingCases.filter((entry) => entry.split === "test")).toHaveLength(24);
    expect(
      skillRoutingCases.filter((entry) => entry.rosterSize === "large").length,
    ).toBeGreaterThanOrEqual(30);
    expect(skillRoutingCases.filter((entry) => entry.adversarial).length).toBeGreaterThanOrEqual(
      15,
    );
    expect(
      skillRoutingCases.filter((entry) => entry.scenario === "no-skill").length,
    ).toBeGreaterThanOrEqual(15);
  });

  it("emits a deterministic report without request or skill bodies", () => {
    const first = runLexicalRoutingBenchmark("test");
    const second = runLexicalRoutingBenchmark("test");
    expect(first).toEqual(second);
    expect(first.overall.brierScore).toBeNull();
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain("extract tables from this scanned document");
    expect(serialized).not.toContain(skillRoutingCases[0]!.roster[0]!.description);
  });
});
