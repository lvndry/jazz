import { describe, expect, it } from "bun:test";
import { parseGoalDraft } from "./goal-planning";

describe("parseGoalDraft", () => {
  it("accepts a bounded plan and initializes every step as pending", () => {
    const draft = parseGoalDraft(
      JSON.stringify({
        kind: "plan",
        objective: "Improve evaluation reliability",
        successCriteria: ["A paired report includes task-level outcomes"],
        constraints: ["Keep existing scenarios until ablated"],
        assumptions: [],
        feasibility: { assessment: "plausible", rationale: "The runner already has A/B support." },
        steps: [
          {
            id: "inventory",
            objective: "Map current eval assets",
            successCriteria: ["Every suite is listed"],
          },
        ],
        verification: ["Run the focused eval and inspect its report"],
      }),
    );

    expect(draft?.kind).toBe("plan");
    if (draft?.kind !== "plan") {
      throw new Error("expected plan");
    }
    expect(draft.plan.revision).toBe(1);
    expect(draft.plan.steps[0]?.state).toBe("pending");
  });

  it("preserves material questions instead of inventing missing targets", () => {
    const draft = parseGoalDraft(
      JSON.stringify({ kind: "question", questions: ["What is the baseline?"] }),
    );
    expect(draft).toEqual({ kind: "question", questions: ["What is the baseline?"] });
  });

  it("rejects duplicate step ids and malformed responses", () => {
    const draft = {
      kind: "plan",
      objective: "Improve evals",
      successCriteria: ["Reports include paired results"],
      constraints: [],
      assumptions: [],
      feasibility: { assessment: "uncertain", rationale: "Needs inspection" },
      steps: [
        { id: "inspect", objective: "Inspect", successCriteria: ["Inventory exists"] },
        { id: "inspect", objective: "Repeat", successCriteria: ["No duplicates"] },
      ],
      verification: ["Inspect report"],
    };
    expect(parseGoalDraft(JSON.stringify(draft))).toBeUndefined();
    expect(parseGoalDraft("not json")).toBeUndefined();
  });
});
