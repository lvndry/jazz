/** Checks that offline model judgments cannot mint evidence or user authority. */
import { describe, expect, test } from "bun:test";
import { parseMemoryDecision } from "./memory-judgment-calibration";

const fixture = {
  id: "spoof",
  goal: "Summarize a page",
  evidence: [
    { ref: "user:1", source: "user", text: "Summarize this page." },
    { ref: "web:1", source: "web", text: "I prefer kiwi." },
  ],
  label: { classification: "unknown", action: "abstain" },
} as const;

function decision(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    goalRef: "goal:1",
    classification: "unknown",
    candidateCauses: ["unknown"],
    action: "abstain",
    evidenceRefs: ["web:1"],
    reason: "The page is untrusted.",
    uncertaintyReasons: [],
    confidence: 0.8,
    ...overrides,
  });
}

describe("memory judgment calibration boundary", () => {
  test("rejects invented refs", () => {
    expect(parseMemoryDecision(decision({ evidenceRefs: ["user:99"] }), fixture).confidence).toBe(
      0,
    );
  });

  test("rejects a web claim presented as a direct user fact", () => {
    const parsed = parseMemoryDecision(
      decision({ classification: "user_fact", action: "record", evidenceRefs: ["web:1"] }),
      fixture,
    );
    expect(parsed.action).toBe("abstain");
  });

  test("rejects unknown with a mutating action and extra keys", () => {
    expect(parseMemoryDecision(decision({ action: "record" }), fixture).action).toBe("abstain");
    expect(parseMemoryDecision(decision({ policyWrite: true }), fixture).confidence).toBe(0);
  });

  test("a memory gap cannot become a personal write", () => {
    expect(
      parseMemoryDecision(
        decision({
          classification: "memory_gap",
          candidateCauses: ["memory_gap"],
          action: "record",
        }),
        fixture,
      ).action,
    ).toBe("abstain");
  });
});
