import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { toolGroundedAnswerCheck } from "../../checks";
import type { EvalTask } from "../../types";

export const tasks: EvalTask[] = [
  {
    id: "grounding-repo-test-framework",
    domain: "grounding",
    prompt: "What test framework does this repo use? Check the project files, don't guess.",
    baseDifficulty: "trivial",
    setup(workspaceDir) {
      writeFileSync(
        join(workspaceDir, "package.json"),
        JSON.stringify(
          {
            name: "sample-repo",
            scripts: { test: "ava" },
            devDependencies: { ava: "^6.0.0" },
          },
          null,
          2,
        ),
      );
      writeFileSync(
        join(workspaceDir, "math.test.js"),
        "import test from 'ava';\n\ntest('adds', (t) => {\n  t.is(1 + 1, 2);\n});\n",
      );
    },
    check(result) {
      return toolGroundedAnswerCheck(result, {
        toolNames: ["read_file", "grep", "find", "glob", "head", "tail"],
        answerPatterns: [/\bava\b/i],
      });
    },
  },
];
