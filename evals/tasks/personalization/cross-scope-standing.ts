import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scopeCompositionCheck } from "../../checks";
import { runJazzOnce } from "../../run-jazz";
import type { EvalTask, OneShotResult, TaskRunContext } from "../../types";

const PROMPT =
  "Prepare a project update for my colleagues. Keep it concise and state the exact verification command.";

/**
 * Seeds memory inside the rollout's private JAZZ_HOME — never the user's own.
 *
 * `personal` and `work` are the scopes the agent is given; `friends` exists on
 * disk but is not configured, which is what the leakage check is about: an
 * entry the agent has no scope for must not shape the answer.
 */
function seedMemory(jazzHome: string, agentId: string): void {
  const agentPath = join(jazzHome, "agents", `${agentId}.json`);
  const agent = JSON.parse(readFileSync(agentPath, "utf-8")) as {
    config: Record<string, unknown>;
  };
  agent.config["memoryScopes"] = ["personal", "work"];
  writeFileSync(agentPath, `${JSON.stringify(agent, null, 2)}\n`);

  const entries: readonly [string, string, string][] = [
    [
      "personal",
      "communication.md",
      "The user prefers project updates in exactly three bullet points.\n",
    ],
    [
      "work",
      "verification.md",
      "Engineering project updates must name the exact verification command: bun test evals.\n",
    ],
    ["friends", "humor.md", "Every message to friends opens with a friend joke.\n"],
  ];
  for (const [scope, name, content] of entries) {
    const directory = join(jazzHome, "memory", scope, "always");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, name), content);
  }
}

export const tasks: EvalTask[] = [
  {
    id: "personalization-cross-scope-standing",
    domain: "personalization",
    prompt: PROMPT,
    baseDifficulty: "medium",
    setup(workspaceDir) {
      writeFileSync(join(workspaceDir, "status.md"), "The release is ready for verification.");
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
        [
          { name: "three bullets", pattern: /three|•|^- /im },
          { name: "verification command", pattern: /bun test evals/i },
        ],
        [/friend joke/i],
      );
    },
  },
];
