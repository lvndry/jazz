import { describe, expect, it } from "bun:test";
import {
  extractDisposition,
  goalEvaluationRepairMessages,
  goalEvaluationSchemaForPlan,
  quoteAppears,
  toolOutputTexts,
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
  const output = ["Ran 42 tests across 7 files.\n 42 pass\n  0 fail\nDone in 1.2s"];

  it("ignores whitespace reflow and surrounding quote marks", () => {
    expect(quoteAppears('"42 pass 0 fail"', output)).toBe(true);
  });

  it("accepts elided quotes whose fragments appear in order", () => {
    expect(quoteAppears("Ran 42 tests ... 0 fail", output)).toBe(true);
    expect(quoteAppears("Ran 42 tests ... Done in 1.2s", output)).toBe(true);
    expect(quoteAppears("Done in 1.2s … Ran 42 tests", output)).toBe(false);
  });

  it("rejects short quotes, paraphrases, and elisions that could match anything", () => {
    expect(quoteAppears("pass", output)).toBe(false);
    expect(quoteAppears("all 42 tests passed", output)).toBe(false);
    expect(quoteAppears("R...a...n...4...2...t", output)).toBe(false);
    expect(quoteAppears("Ran 42 t... across ... files. ... Done in", output)).toBe(false);
  });

  it("matches within one tool result, never across two", () => {
    expect(quoteAppears("first result ... second result", ["first result", "second result"])).toBe(
      false,
    );
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

describe("reading a live cycle's answer", () => {
  /**
   * The regression, from a live goal on a local model: the fix was right and verified, but
   * the answer explained itself before the JSON and quoted `bun test` output that the command
   * result stores JSON-escaped, so the goal went to review instead of completing.
   */
  it("accepts prose followed by the disposition, quoting decoded command output", () => {
    const commandResult = JSON.stringify({ exitCode: 0, stderr: "1 pass\n 0 fail\nRan 1 test" });
    const answer = [
      "Fixed the slug function; `bun test` reports 1 pass, 0 fail.",
      "",
      JSON.stringify({
        status: "complete",
        summary: "Fixed.",
        evidence: [
          { criterion: 1, quote: "1 pass\n 0 fail" },
          { criterion: 2, quote: '"exitCode":0' },
        ],
      }),
    ].join("\n");

    const result = validateGoalEvaluation(answer, plan, [
      { role: "tool", name: "execute_command", content: commandResult },
    ]);

    expect(result.kind).toBe("valid");
  });

  it("finds the last disposition in prose or a fenced block and rejects answers with none", () => {
    expect(extractDisposition('Done.\n```json\n{"status":"blocked","summary":"x"}\n```')).toEqual({
      status: "blocked",
      summary: "x",
    });
    expect(
      extractDisposition('I used {braces} here. {"status":"question","question":"Which?"}'),
    ).toEqual({ status: "question", question: "Which?" });
    expect(() => extractDisposition("All done, everything works.")).toThrow();
  });

  it("exposes JSON tool results' string values and ignores the model's own writes", () => {
    const texts = toolOutputTexts([
      {
        role: "tool",
        name: "execute_command",
        content: JSON.stringify({ stdout: 'said "hi"\nbye' }),
      },
      { role: "tool", name: "read_file", content: "plain text result" },
      { role: "tool", name: "write_file", content: JSON.stringify({ diff: "+ all tests pass" }) },
      { role: "user", content: "user text is not tool output" },
    ]);

    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain('said "hi"\nbye');
    expect(texts[1]).toBe("plain text result");
  });
});
