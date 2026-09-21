/** Exercises strict decision and skill-distribution boundary validation. */

import { describe, expect, it } from "bun:test";
import type {
  CommandRiskOutcome,
  CompactToolsInput,
  DecisionRequest,
  SkillRouteInput,
} from "@/core/types/plugin";
import {
  validateCommandRiskInput,
  validateCommandRiskOutcome,
  validateCompactToolsOutcome,
  validateDecisionResult,
  validateSkillRouteDistribution,
} from "./validation";

describe("plugin boundary validation", () => {
  it("requires an explicit normalized no-skill outcome", () => {
    const input: SkillRouteInput = {
      requestText: "deploy",
      skills: [{ name: "railway", description: "deploys" }],
    };
    expect(() =>
      validateSkillRouteDistribution(input, {
        skills: [{ name: "railway", probability: 0.7 }],
        noSkillProbability: 0.3,
      }),
    ).not.toThrow();
    expect(() =>
      validateSkillRouteDistribution(input, {
        skills: [{ name: "railway", probability: 0.7 }],
        noSkillProbability: 0,
      }),
    ).toThrow();
  });

  it("rejects partial decision batches and unnormalized choices", () => {
    const request: DecisionRequest = {
      state: { request: "x" },
      questions: [
        {
          id: "q",
          question: {
            kind: "choice",
            instructions: "pick",
            options: [{ value: "a" }, { value: "b" }],
          },
        },
      ],
    };
    expect(() =>
      validateDecisionResult(request, {
        providerId: "p",
        model: "m",
        latencyMs: 1,
        answers: [
          {
            id: "q",
            outcome: {
              status: "answered",
              answer: {
                kind: "choice",
                choice: "a",
                probabilities: [
                  { value: "a", probability: 0.8 },
                  { value: "b", probability: 0.3 },
                ],
              },
            },
          },
        ],
      }),
    ).toThrow();
  });

  it("accepts only bounded commands and exact normalized risk distributions", () => {
    expect(validateCommandRiskInput({ command: "git status" }).command).toBe("git status");
    expect(() => validateCommandRiskInput({ command: "" })).toThrow("1-4000");
    expect(() => validateCommandRiskInput({ command: "x".repeat(4_001) })).toThrow("1-4000");
    expect(() =>
      validateCommandRiskInput({ command: "git status", extra: true } as unknown as {
        command: string;
      }),
    ).toThrow("exactly command");

    expect(() =>
      validateCommandRiskOutcome({
        status: "answered",
        distribution: {
          readOnlyProbability: 0.8,
          lowRiskProbability: 0.1,
          highRiskProbability: 0.1,
        },
      }),
    ).not.toThrow();
    expect(() =>
      validateCommandRiskOutcome({
        status: "answered",
        distribution: {
          readOnlyProbability: 0.8,
          lowRiskProbability: 0.1,
          highRiskProbability: 0.2,
        },
      }),
    ).toThrow("sum to 1");
    expect(() =>
      validateCommandRiskOutcome({
        status: "answered",
        distribution: {
          readOnlyProbability: 0.8,
          lowRiskProbability: 0.1,
          highRiskProbability: 0.1,
          extra: 0,
        },
      } as unknown as CommandRiskOutcome),
    ).toThrow("exactly three");
  });

  it("requires an explicit bounded abstention reason", () => {
    expect(() =>
      validateCommandRiskOutcome({ status: "abstained", reason: "provider unavailable" }),
    ).not.toThrow();
    expect(() => validateCommandRiskOutcome({ status: "abstained", reason: "" })).toThrow(
      "abstention reason",
    );
    expect(() =>
      validateCommandRiskOutcome({ status: "abstained", reason: "x".repeat(513) }),
    ).toThrow("abstention reason");
    expect(() =>
      validateCommandRiskOutcome({
        status: "abstained",
        reason: "not sure",
        extra: true,
      } as unknown as CommandRiskOutcome),
    ).toThrow("abstention reason");
  });

  const twoCandidateInput: CompactToolsInput = {
    goal: "trim stale results",
    candidates: [
      { id: "a", tool: "read", resultPreview: "x", resultChars: 10, isError: false },
      { id: "b", tool: "grep", resultPreview: "y", resultChars: 20, isError: false },
    ],
  };

  it("accepts an answer that covers every candidate", () => {
    const outcome = validateCompactToolsOutcome(twoCandidateInput, {
      status: "answered",
      decisions: [
        { id: "a", action: "drop" },
        { id: "b", action: "keep" },
      ],
    });
    expect(outcome.status).toBe("answered");
  });

  it("abstains on a partial answer instead of silently keeping the rest", () => {
    const outcome = validateCompactToolsOutcome(twoCandidateInput, {
      status: "answered",
      decisions: [{ id: "a", action: "drop" }],
    });
    expect(outcome).toEqual({
      status: "abstained",
      reason: "compact tools response covered 1 of 2 candidates",
    });
  });
});
