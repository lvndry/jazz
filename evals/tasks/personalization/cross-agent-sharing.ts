import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { requiredAndForbiddenPatternCheck } from "../../checks";
import { updateAgentConfig } from "../../files";
import { runJazzOnce } from "../../run-jazz";
import type { EvalTask, OneShotResult, TaskRunContext } from "../../types";

/**
 * Memory is shared by every agent in a home: a standing entry written for one
 * agent's context (a non-default scope) must be injected into a *different*
 * agent's run. The memory tools are denied so the name can only reach the
 * answer through the shared store, not a lookup.
 */
const PROMPT = "Say hello to me in a short one-liner.";
const DENIED_LOOKUP_TOOLS = ["view_memory", "manage_memory"];

function seedSharedEntry(jazzHome: string): void {
  const directory = join(jazzHome, "memory", "friends", "always");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "hello-name.md"),
    'The user said: "Address me as Landry, not by my full name."\n',
  );
}

export const tasks: EvalTask[] = [
  {
    id: "personalization-cross-agent-sharing",
    domain: "personalization",
    prompt: PROMPT,
    baseDifficulty: "trivial",
    setup() {},
    async run(context: TaskRunContext): Promise<OneShotResult> {
      // The seed belongs to the primary eval agent's context; the run below
      // is a *different* agent in the same home, which must still see it.
      seedSharedEntry(context.jazzHome);
      const otherAgentId = "eval-sut-other";
      updateAgentConfig(context.jazzHome, otherAgentId, {
        deniedTools: DENIED_LOOKUP_TOOLS,
      });
      return runJazzOnce({
        prompt: PROMPT,
        agentId: otherAgentId,
        workspaceDir: context.workspaceDir,
        cassettePath: context.cassettePath,
        timeoutMs: context.timeoutMs,
        runId: context.runId,
        jazzHome: context.jazzHome,
        environment: context.environment,
      });
    },
    check(result) {
      return requiredAndForbiddenPatternCheck(result.answer, [
        { name: "injected name", pattern: (answer) => /landry/i.test(answer) },
      ]);
    },
  },
];
