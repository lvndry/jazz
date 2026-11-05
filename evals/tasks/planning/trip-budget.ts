import { constraintCheck } from "../../checks";
import type { EvalTask } from "../../types";

export const tasks: EvalTask[] = [
  {
    id: "planning-trip-budget",
    domain: "planning",
    prompt:
      "Plan a 2-day trip that departs on Monday and includes 2 nights of lodging. Hard constraint: the total cost must be under $500. Output the plan and end with a line 'Total: $<amount>'.",
    baseDifficulty: "medium",
    setup() {},
    check(result) {
      return constraintCheck(result, [
        { name: "departs-monday", test: (answer) => /monday/i.test(answer) },
        { name: "two-nights", test: (answer) => /(2|two)\s*night/i.test(answer) },
        {
          name: "under-budget",
          test: (answer) => {
            const match = answer.match(/total[^0-9]*\$?\s*([0-9][0-9,]*)/i);
            if (!match) {
              return false;
            }
            return parseInt(match[1]!.replace(/,/g, ""), 10) < 500;
          },
        },
      ]);
    },
  },
];
