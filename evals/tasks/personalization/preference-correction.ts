import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scopeCompositionCheck } from "../../checks";
import type { EvalTask } from "../../types";

export const tasks: EvalTask[] = [
  {
    id: "personalization-preference-correction",
    domain: "personalization",
    prompt: "Write a project update.",
    baseDifficulty: "medium",
    setup(workspaceDir) {
      const home = process.env["JAZZ_HOME"];
      if (home === undefined) return;
      mkdirSync(join(home, "memory", "personal", "always"), { recursive: true });
      writeFileSync(
        join(home, "memory", "personal", "always", "communication.md"),
        "Project updates should be concise and use exactly three bullet points.\n",
      );
      writeFileSync(join(workspaceDir, "context.md"), "Release verification is complete.");
    },
    check(result) {
      return scopeCompositionCheck(result.answer, [
        { name: "concise structure", pattern: /three|•|^- /im },
      ]);
    },
  },
];
