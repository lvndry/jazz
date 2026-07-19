import { describe, expect, it } from "bun:test";
import type { JudgeFn } from "./checks";
import { calibrateJudge, parseScore, pearson } from "./judge";

describe("pearson", () => {
  it("is 1 for perfectly correlated series", () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 5);
  });
  it("is -1 for perfectly anti-correlated series", () => {
    expect(pearson([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 5);
  });
  it("is 0 on zero variance or length mismatch", () => {
    expect(pearson([1, 1, 1], [1, 2, 3])).toBe(0);
    expect(pearson([1, 2], [1, 2, 3])).toBe(0);
  });
});

describe("parseScore", () => {
  it("extracts and clamps a 0..1 score", () => {
    expect(parseScore("Score: 0.8")).toBe(0.8);
    expect(parseScore("1")).toBe(1);
    expect(parseScore("2.5")).toBe(1);
    expect(parseScore("nonsense")).toBe(0);
  });
});

describe("calibrateJudge", () => {
  const rows = [
    { prompt: "p1", output: "o1", human: 1 },
    { prompt: "p2", output: "o2", human: 0 },
    { prompt: "p3", output: "o3", human: 1 },
    { prompt: "p4", output: "o4", human: 0 },
  ];

  it("passes the gate when the judge tracks human labels", async () => {
    const goodJudge: JudgeFn = async (prompt) => (prompt === "p1" || prompt === "p3" ? 1 : 0);
    const result = await calibrateJudge(goodJudge, rows, 0.7);
    expect(result.r).toBeCloseTo(1, 5);
    expect(result.ok).toBe(true);
  });

  it("fails the gate when the judge anti-correlates", async () => {
    const badJudge: JudgeFn = async (prompt) => (prompt === "p1" || prompt === "p3" ? 0 : 1);
    const result = await calibrateJudge(badJudge, rows, 0.7);
    expect(result.ok).toBe(false);
  });
});
