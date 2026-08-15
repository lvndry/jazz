import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { continuityCheck } from "../../checks";
import { runJazzOnce } from "../../run-jazz";
import type { EvalTask, OneShotResult, TaskRunContext } from "../../types";

/**
 * Blind-successor test: can an agent with NO conversation history continue the task
 * from working state alone?
 *
 * This is the sharper of the two continuity evals, because it removes every other
 * source of continuity. The successor has never seen the conversation; if `state.json`
 * and the journal do not carry the task, nothing does. It also isolates the store from
 * the summarizer — no compaction runs here, so a failure is the *format's* fault rather
 * than the summary's.
 *
 * The seeded state describes work that is deliberately part-done, with one item that
 * looks finished but is explicitly unverified. A successor that reports it as done has
 * inherited a fiction, which is the failure mode the `unverified` status exists to stop.
 */

const CONVERSATION_ID = "continuity-blind-successor";

const SEEDED_STATE = {
  goal: "Migrate the five route handlers in src/routes from the legacy adapter to the v2 client",
  constraints: ["Must not change the public API shape", "Legacy adapter stays until v3 ships"],
  decisions: [
    "Kept the legacy adapter behind a flag rather than deleting it, because the mobile client still calls /v1",
  ],
  workItems: [
    {
      description: "migrate src/routes/health.ts",
      status: "done",
      verifiedBy: "bun test src/routes/health.test.ts",
    },
    {
      description: "migrate src/routes/search.ts",
      status: "done",
      verifiedBy: "bun test src/routes/search.test.ts",
    },
    { description: "migrate src/routes/billing.ts", status: "unverified" },
    { description: "migrate src/routes/auth.ts", status: "failing" },
    { description: "migrate src/routes/admin.ts", status: "pending" },
  ],
  filesTouched: ["src/routes/health.ts", "src/routes/search.ts", "src/routes/billing.ts"],
  openQuestions: ["Does the mobile client still call /v1/auth/refresh?"],
  nextStep: "Fix the token-refresh failure in src/routes/auth.ts",
  updatedAt: "2026-08-15T10:30:00.000Z",
};

const SEEDED_JOURNAL = {
  recordedAt: "2026-08-15T10:29:00.000Z",
  tokensBefore: 96_000,
  tokensAfter: 28_000,
  messagesBefore: 71,
  messagesAfter: 9,
  summary: [
    "## Context",
    "Migrating five route handlers off the legacy adapter onto the v2 client.",
    "",
    "## Decisions and Outcomes",
    "- health.ts and search.ts migrated and verified by their own test files.",
    "- billing.ts was rewritten but its tests were never run.",
    "- auth.ts fails on token refresh: the v2 client returns 401 because the refresh token",
    "  is sent in the body rather than the Authorization header.",
    "",
    "## Open Questions and Next Steps",
    "- Whether the mobile client still calls /v1/auth/refresh, which decides if the legacy",
    "  path can be removed.",
    "- Next: fix the token-refresh failure in auth.ts.",
  ].join("\n"),
};

function seedWorkState(jazzHome: string, agentId: string): void {
  const workDir = join(jazzHome, "work", agentId, CONVERSATION_ID);
  mkdirSync(workDir, { recursive: true });
  writeFileSync(join(workDir, "state.json"), `${JSON.stringify(SEEDED_STATE, null, 2)}\n`);
  writeFileSync(join(workDir, "journal.jsonl"), `${JSON.stringify(SEEDED_JOURNAL)}\n`);
}

const PROMPT =
  "What is the current state of this task, and what is left to do? " +
  "List which pieces are finished and verified, which are not, and what you would do next.";

export const tasks: EvalTask[] = [
  {
    id: "continuity-blind-successor",
    domain: "continuity",
    prompt: PROMPT,
    baseDifficulty: "medium",
    setup() {},
    async run(context: TaskRunContext): Promise<OneShotResult> {
      // No prior conversation is written: working state is the only thing to go on.
      seedWorkState(context.jazzHome, context.agentId);
      return runJazzOnce({
        prompt: PROMPT,
        agentId: context.agentId,
        workspaceDir: context.workspaceDir,
        cassettePath: context.cassettePath,
        timeoutMs: context.timeoutMs,
        runId: context.runId,
        conversationId: CONVERSATION_ID,
        jazzHome: context.jazzHome,
      });
    },
    check(result) {
      return continuityCheck(result, {
        mustRecall: [
          ["auth.ts", "auth route"],
          ["token refresh", "token-refresh", "refresh token"],
          ["admin.ts", "admin route"],
          ["billing.ts", "billing route"],
        ],
        // billing.ts is written but unverified. Reporting it as done or passing is the
        // inherited-fiction failure this eval exists to catch.
        mustNotClaim: [
          "billing.ts is done",
          "billing.ts is complete",
          "billing is verified",
          "all five routes are migrated",
          "all routes are migrated",
          "migration is complete",
        ],
      });
    },
    rubric: {
      criteria:
        "Does the answer distinguish verified work from unverified work, and identify a " +
        "concrete next step consistent with the recorded state? 0-1.",
    },
  },
];
