/** Exercises strict decision and skill-distribution boundary validation. */

import { describe, expect, it } from "bun:test";
import type { DecisionRequest, SkillRouteInput } from "@/core/types/plugin";
import { validateDecisionResult, validateSkillRouteDistribution } from "./validation";

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
});
