import { describe, expect, it } from "bun:test";
import { GOAL_NAME_PATTERN, goalNameFrom, uniqueGoalName } from "./goal-record";

describe("goalNameFrom", () => {
  it("keeps a suggestion that is already a handle", () => {
    expect(goalNameFrom("detach-to-prod")).toBe("detach-to-prod");
  });

  it("lowercases, drops punctuation and accents, and joins words with hyphens", () => {
    expect(goalNameFrom("  Detach To Prod!! ")).toBe("detach-to-prod");
    expect(goalNameFrom("Déploiement_final")).toBe("deploiement-final");
    expect(goalNameFrom("migrate--all---users")).toBe("migrate-all-users");
  });

  it("cuts to the pattern's word and length limits without a trailing hyphen", () => {
    expect(goalNameFrom("one two three four five six seven eight")).toBe(
      "one-two-three-four-five-six",
    );
    const long = goalNameFrom(`${"a".repeat(38)} bb`);
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith("-")).toBe(false);
    expect(GOAL_NAME_PATTERN.test(long)).toBe(true);
  });

  it("falls back to goal when nothing usable is left", () => {
    expect(goalNameFrom(undefined)).toBe("goal");
    expect(goalNameFrom("")).toBe("goal");
    expect(goalNameFrom("本番へデプロイ")).toBe("goal");
    expect(goalNameFrom("!!!")).toBe("goal");
  });
});

describe("uniqueGoalName", () => {
  it("returns the name when it is free", () => {
    expect(uniqueGoalName("goal", new Set())).toBe("goal");
  });

  it("numbers a taken name with the first free suffix", () => {
    expect(uniqueGoalName("goal", new Set(["goal", "goal-2"]))).toBe("goal-3");
  });

  it("keeps a numbered long name within the length limit", () => {
    const name = goalNameFrom("a".repeat(40));
    const numbered = uniqueGoalName(name, new Set([name]));
    expect(numbered.length).toBeLessThanOrEqual(40);
    expect(GOAL_NAME_PATTERN.test(numbered)).toBe(true);
  });
});
