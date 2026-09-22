import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scopeCompositionCheck } from "../../checks";
import { runJazzOnce } from "../../run-jazz";
import type { EvalTask, OneShotResult, TaskRunContext } from "../../types";

/**
 * The stored preference says bullets; the request corrects it in the same
 * breath. The injected memory must lose to the live correction — an agent that
 * follows the standing entry over what the person just said is worse than one
 * with no memory at all.
 */
const PROMPT =
  "Write a project update from context.md. I used to want bullet points for these, but from now on make it one short paragraph with no bullets.";

function seedMemory(jazzHome: string, agentId: string): void {
  const agentPath = join(jazzHome, "agents", `${agentId}.json`);
  const agent = JSON.parse(readFileSync(agentPath, "utf-8")) as {
    config: Record<string, unknown>;
  };
  agent.config["memoryScopes"] = ["personal"];
  writeFileSync(agentPath, `${JSON.stringify(agent, null, 2)}\n`);

  const directory = join(jazzHome, "memory", "personal", "always");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "communication.md"),
    "Project updates should be concise and use exactly three bullet points.\n",
  );
}

export const tasks: EvalTask[] = [
  {
    id: "personalization-preference-correction",
    domain: "personalization",
    prompt: PROMPT,
    baseDifficulty: "medium",
    setup(workspaceDir) {
      writeFileSync(join(workspaceDir, "context.md"), "Release verification is complete.");
    },
    async run(context: TaskRunContext): Promise<OneShotResult> {
      seedMemory(context.jazzHome, context.agentId);
      return runJazzOnce({
        prompt: PROMPT,
        agentId: context.agentId,
        workspaceDir: context.workspaceDir,
        cassettePath: context.cassettePath,
        timeoutMs: context.timeoutMs,
        runId: context.runId,
        jazzHome: context.jazzHome,
      });
    },
    check(result) {
      return scopeCompositionCheck(
        result.answer,
        [{ name: "mentions verification", pattern: /verification/i }],
        [/^\s*[-•*] /m],
      );
    },
  },
];
