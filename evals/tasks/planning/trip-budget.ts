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
        { name: "departs-monday", test: (a) => /monday/i.test(a) },
        { name: "two-nights", test: (a) => /(2|two)\s*night/i.test(a) },
        {
          name: "under-budget",
          test: (a) => {
            const match = a.match(/total[^0-9]*\$?\s*([0-9][0-9,]*)/i);
            if (!match) return false;
            return parseInt(match[1]!.replace(/,/g, ""), 10) < 500;
          },
        },
      ]);
    },
  },
];
