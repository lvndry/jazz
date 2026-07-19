import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { constraintCheck } from "../../checks";
import type { EvalTask } from "../../types";

export const tasks: EvalTask[] = [
  {
    id: "productivity-extract-meeting",
    domain: "productivity",
    prompt:
      "Read the file notes.txt in the current working directory and tell me the day of the week and the time of the Q3 review meeting.",
    baseDifficulty: "trivial",
    setup(workspaceDir) {
      writeFileSync(
        join(workspaceDir, "notes.txt"),
        "Team updates:\n- The Q3 review meeting was moved to Thursday at 2pm in room B.\n- Lunch is at noon.\n",
      );
    },
    check(result) {
      return constraintCheck(result, [
        { name: "day", test: (a) => /thursday/i.test(a) },
        { name: "time", test: (a) => /2\s*pm|14:00|2:00/i.test(a) },
      ]);
    },
  },
];
