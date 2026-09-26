import { describe, expect, it } from "bun:test";
import {
  goalEvaluationRepairMessages,
  goalEvaluationSchemaForPlan,
  quoteAppears,
  validateGoalEvaluation,
} from "./goal-evaluation";
import type { GoalPlan } from "./goal-record";

const plan: GoalPlan = {
  revision: 1,
  objective: "Improve the evaluation report",
  successCriteria: ["Paired results are reported", "Every sample is auditable"],
  constraints: [],
  assumptions: [],
  feasibility: { assessment: "plausible", rationale: "The runner already writes reports." },
  steps: [
    {
      id: "report",
      objective: "Add reports",
      successCriteria: ["Report exists"],
      state: "pending",
    },
  ],
  verification: ["Inspect the generated JSON"],
};

describe("validateGoalEvaluation", () => {
  it("restricts repaired step IDs to the accepted plan revision", () => {
    const parsed = goalEvaluationSchemaForPlan(plan).safeParse({
      status: "continue",
      summary: "Inventory verified.",
      nextAction: "Research prior art.",
      completedStepIds: ["report"],
    });
    expect(parsed.success).toBe(true);
    expect(
      goalEvaluationSchemaForPlan(plan).safeParse({
        status: "continue",
        summary: "Inventory verified.",
        nextAction: "Research prior art.",
        completedStepIds: ["map-current-eval-pipeline"],
      }).success,
    ).toBe(false);
  });

  it("builds a bounded repair request that labels cycle output and tool results as data", () => {
    const messages = goalEvaluationRepairMessages(
      plan,
      "Earlier progress",
      "A prose completion attempt",
      [
        { role: "tool", name: "read_file", content: "tool output".repeat(250) },
        { role: "assistant", content: "ignored assistant content" },
      ],
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toContain("untrusted data");
    const data = JSON.parse(messages[1]?.content ?? "{}") as {
      cycleResponse: string;
      toolOutputs: { content: string }[];
    };
    expect(data.cycleResponse).toBe("A prose completion attempt");
    expect(data.toolOutputs[0]?.content.length).toBeLessThanOrEqual(2_000);
    expect(data.toolOutputs[0]?.content).toContain("tool output");
  });

  it("accepts evidence citing every criterion by number with quotes from tool output", () => {
    const output = JSON.stringify({
      status: "complete",
      summary: "Both checks are recorded.",
      evidence: [
        { criterion: 1, quote: "paired_delta: 0.12" },
        { criterion: 2, quote: "sample_trace: reports/run-01.jsonl" },
      ],
    });
    const messages = [
      { role: "tool" as const, name: "read_file", content: "paired_delta: 0.12" },
      { role: "tool" as const, name: "read_file", content: "sample_trace: reports/run-01.jsonl" },
    ];

    expect(validateGoalEvaluation(output, plan, messages)).toEqual({
      kind: "valid",
      evaluation: {
        status: "complete",
        summary: "Both checks are recorded.",
        evidence: [
          { criterion: "Paired results are reported", quote: "paired_delta: 0.12" },
          { criterion: "Every sample is auditable", quote: "sample_trace: reports/run-01.jsonl" },
        ],
      },
    });
  });

  it("rejects quotes absent from tool output, missing criteria, and unknown numbers", () => {
    const complete = (evidence: unknown[]) =>
      JSON.stringify({ status: "complete", summary: "Done.", evidence });
    const tools = [{ role: "tool" as const, name: "run", content: "12 pass 0 fail" }];

    expect(
      validateGoalEvaluation(complete([{ criterion: 1, quote: "all tests passed" }]), plan, tools),
    ).toMatchObject({
      kind: "invalid",
      reason: "Completion evidence for criterion 1 does not appear in this cycle's tool output.",
    });
    expect(
      validateGoalEvaluation(complete([{ criterion: 1, quote: "12 pass 0 fail" }]), plan, tools),
    ).toMatchObject({
      kind: "invalid",
      reason: "Completion did not provide evidence for criteria 2.",
    });
    expect(
      validateGoalEvaluation(complete([{ criterion: 3, quote: "12 pass 0 fail" }]), plan, tools),
    ).toMatchObject({
      kind: "invalid",
      reason: "Completion cited criterion 3, which the accepted plan does not have.",
    });
  });
});

describe("quoteAppears", () => {
  const output = "Ran 42 tests across 7 files.\n 42 pass\n  0 fail\nDone in 1.2s";

  it("ignores whitespace reflow and surrounding quote marks", () => {
    expect(quoteAppears('"42 pass 0 fail"', output)).toBe(true);
  });

  it("accepts elided quotes whose fragments appear in order", () => {
    expect(quoteAppears("Ran 42 tests ... 0 fail", output)).toBe(true);
    expect(quoteAppears("0 fail … Ran 42 tests", output)).toBe(false);
  });

  it("rejects quotes too short to prove anything and paraphrases", () => {
    expect(quoteAppears("pass", output)).toBe(false);
    expect(quoteAppears("all 42 tests passed", output)).toBe(false);
  });
});

describe("validateGoalEvaluation dispositions", () => {
  it("rejects fabricated step ids and malformed disposition JSON", () => {
    const invalidStep = validateGoalEvaluation(
      JSON.stringify({
        status: "continue",
        summary: "Progress made.",
        nextAction: "Verify",
        completedStepIds: ["outside-plan"],
      }),
      plan,
      [],
    );
    expect(invalidStep.kind).toBe("invalid");
    expect(validateGoalEvaluation("done", plan, []).kind).toBe("invalid");
  });
});
