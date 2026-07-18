import { fileStateCheck } from "../../checks";
import type { EvalTask } from "../../types";

export const tasks: EvalTask[] = [
  {
    id: "tooluse-write-report",
    domain: "tooluse",
    prompt:
      "Create a file named report.md in the current working directory whose contents are exactly the line: STATUS: OK",
    baseDifficulty: "trivial",
    setup() {},
    check(_result, workspaceDir) {
      return fileStateCheck(workspaceDir, { path: "report.md", mustContain: ["STATUS: OK"] });
    },
  },
];
