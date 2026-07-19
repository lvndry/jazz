import { toolGroundedAnswerCheck } from "../../checks";
import type { EvalTask } from "../../types";

export const tasks: EvalTask[] = [
  {
    id: "grounding-latest-bun-version",
    domain: "grounding",
    prompt:
      "What is the latest released version of Bun (the JavaScript runtime, oven-sh/bun)? " +
      "Your training data may be stale, so check https://api.github.com/repos/oven-sh/bun/releases/latest " +
      "rather than recalling a version from memory, and state the exact version tag.",
    baseDifficulty: "medium",
    setup() {},
    check(result) {
      return toolGroundedAnswerCheck(result, {
        toolNames: ["web_fetch", "http_request"],
        answerPatterns: [/1\.3\.14/],
      });
    },
  },
];
