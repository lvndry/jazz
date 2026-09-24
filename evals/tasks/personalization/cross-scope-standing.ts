import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { requiredAndForbiddenPatternCheck } from "../../checks";
import { runJazzOnce } from "../../run-jazz";
import type { EvalTask, OneShotResult, TaskRunContext } from "../../types";

/** Greeting and sign-off only the unconfigured `friends` scope asks for, so either in the answer is leakage. */
const FRIENDS_GREETING = "Hey legends";
const FRIENDS_SIGN_OFF = "Stay goofy";

/** Bullet count the seeded `personal` preference demands. */
const REQUIRED_BULLET_COUNT = 3;

function containsPhrase(phrase: string): (answer: string) => boolean {
  return (answer) => answer.toLowerCase().includes(phrase.toLowerCase());
}

function bulletLineCount(answer: string): number {
  return answer.match(/^\s*[-•*] /gm)?.length ?? 0;
}

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

  const entries: readonly { scope: string; fileName: string; content: string }[] = [
    {
      scope: "personal",
      fileName: "communication.md",
      content: "The user prefers project updates in exactly three bullet points.\n",
    },
    {
      scope: "work",
      fileName: "verification.md",
      content:
        "Engineering project updates must name the exact verification command: bun test evals.\n",
    },
    {
      scope: "friends",
      fileName: "greetings.md",
      content: `Every message to friends opens with "${FRIENDS_GREETING}!" and signs off with "${FRIENDS_SIGN_OFF}".\n`,
    },
  ];
  for (const { scope, fileName, content } of entries) {
    const directory = join(jazzHome, "memory", scope, "always");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, fileName), content);
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
      return requiredAndForbiddenPatternCheck(
        result.answer,
        [
          {
            name: "exactly three bullets",
            pattern: (answer) => bulletLineCount(answer) === REQUIRED_BULLET_COUNT,
          },
          { name: "verification command", pattern: /bun test evals/i },
        ],
        [containsPhrase(FRIENDS_GREETING), containsPhrase(FRIENDS_SIGN_OFF)],
      );
    },
  },
];
