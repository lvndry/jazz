import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scopeCompositionCheck } from "../../checks";
import type { EvalTask } from "../../types";

export const tasks: EvalTask[] = [
  {
    id: "personalization-cross-scope-standing",
    domain: "personalization",
    prompt:
      "Prepare a project update for my colleagues. Keep it concise and state the exact verification command.",
    baseDifficulty: "medium",
    setup(workspaceDir) {
      const home = process.env["JAZZ_HOME"];
      if (home === undefined) return;
      mkdirSync(join(home, "memory", "personal", "always"), { recursive: true });
      mkdirSync(join(home, "memory", "work", "always"), { recursive: true });
      writeFileSync(
        join(home, "memory", "personal", "always", "communication.md"),
        "The user prefers project updates in exactly three bullet points.\n",
      );
      writeFileSync(
        join(home, "memory", "work", "always", "verification.md"),
        "Engineering project updates must name the exact verification command: bun test evals.\n",
      );
      writeFileSync(join(workspaceDir, "status.md"), "The release is ready for verification.");
    },
    check(result) {
      return scopeCompositionCheck(
        result.answer,
        [
          { name: "three bullets", pattern: /three|•|^- /im },
          { name: "verification command", pattern: /bun test evals/i },
        ],
        [/friend joke/i],
      );
    },
  },
];
