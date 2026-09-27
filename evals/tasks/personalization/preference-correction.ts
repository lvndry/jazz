import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { requiredAndForbiddenPatternCheck } from "../../checks";
import { updateAgentConfig } from "../../files";
import { runJazzOnce } from "../../run-jazz";
import type { EvalTask, OneShotResult, TaskRunContext } from "../../types";

/**
 * Sign-off the stored preference asks for. The prompt and workspace never
 * mention it, so it appears only when the injected memory reached the model.
 */
const MEMORY_SIGN_OFF = "Release desk out";

/**
 * The stored preference says bullets plus a sign-off; the request corrects the
 * bullets in the same breath. The injected memory must lose to the live
 * correction on bullets while its uncorrected sign-off still applies — an agent
 * that follows the standing entry over what the person just said is worse than
 * one with no memory at all.
 */
const PROMPT =
  "Write a project update from context.md. I used to want bullet points for these, but from now on make it one short paragraph with no bullets.";

function seedMemory(jazzHome: string, agentId: string): void {
  updateAgentConfig(jazzHome, agentId, { memoryScopes: ["personal"] });

  const directory = join(jazzHome, "memory", "personal", "always");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "communication.md"),
    `Project updates should be concise, use exactly three bullet points, and end with the sign-off "${MEMORY_SIGN_OFF}."\n`,
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
        environment: context.environment,
      });
    },
    check(result) {
      return requiredAndForbiddenPatternCheck(
        result.answer,
        [
          {
            name: "remembered sign-off",
            pattern: (answer) => answer.toLowerCase().includes(MEMORY_SIGN_OFF.toLowerCase()),
          },
        ],
        [/^\s*[-•*] /m],
      );
    },
  },
];
