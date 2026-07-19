import { comprehensionCheck } from "../../checks";
import { makeJudge } from "../../judge";
import type { EvalTask } from "../../types";

export const tasks: EvalTask[] = [
  {
    id: "tutoring-recursion",
    domain: "tutoring",
    prompt:
      "Explain what recursion is to a beginner programmer, including the role of the base case. Keep it concise.",
    baseDifficulty: "medium",
    setup() {},
    check(result) {
      return comprehensionCheck(
        result,
        [
          { question: "Does a recursive function call itself?", answer: "yes" },
          { question: "What stops a recursion from running forever?", answer: "the base case" },
        ],
        makeJudge(),
      );
    },
  },
];
