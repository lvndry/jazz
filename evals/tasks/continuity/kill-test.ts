import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { continuityCheck, sawCompaction } from "../../checks";
import { runJazzOnce, runJazzUntilKilled } from "../../run-jazz";
import type { EvalTask, OneShotResult, TaskRunContext } from "../../types";

/**
 * Kill test: interrupt a long run mid-flight, resume it, and ask what remains.
 *
 * The end-to-end check the whole context-management design rests on. Unit tests can show
 * that clearing does not orphan tool results and that the journal survives a torn write;
 * none of that tells you a resumed agent knows what it was doing.
 *
 * The kill is a SIGKILL rather than a clean stop on purpose. Conversation history is
 * saved only when a run *completes*, so a killed run leaves none — everything the
 * successor gets has to have been written *during* the run. A `--max-iterations` stop
 * would quietly test the easy path instead.
 *
 * The workspace is seeded with enough bulky material that reading it forces compaction;
 * the kill fires on the first compaction, so the run is guaranteed to have crossed the
 * threshold before it dies. A sample that never compacted proves nothing and is voided
 * rather than scored.
 */

const CONVERSATION_ID = "continuity-kill-test";

/** Distinctive facts planted in the corpus, recoverable only by having read it. */
const PLANTED = {
  failingModule: "quota-reconciler",
  failingReason: "off-by-one on the billing cycle boundary",
  owner: "payments-platform",
};

function seedCorpus(workspaceDir: string): void {
  const notesDir = join(workspaceDir, "notes");
  mkdirSync(notesDir, { recursive: true });

  // Bulk: enough to push a modest context window past the compaction threshold when the
  // agent reads it. Filler is deliberately low-signal so the planted facts are the only
  // thing worth carrying forward.
  for (let index = 0; index < 12; index++) {
    const filler = Array.from(
      { length: 220 },
      (_unused, line) =>
        `service-${index} line ${line}: routine health check completed, no action required, latency nominal, retries zero`,
    ).join("\n");
    writeFileSync(join(notesDir, `service-${index}.log`), filler);
  }

  writeFileSync(
    join(notesDir, "incident-0042.md"),
    [
      "# Incident 0042",
      "",
      `Owner: ${PLANTED.owner}`,
      `Failing module: ${PLANTED.failingModule}`,
      `Root cause: ${PLANTED.failingReason}`,
      "",
      "Remediation is not started. The reconciler must be corrected before the next",
      "billing run, and the fix needs a regression test covering the cycle boundary.",
    ].join("\n"),
  );
}

const FIRST_PROMPT =
  "Read every file under ./notes and build up a picture of the incident described there. " +
  "Record what you learn as you go: the failing module, its root cause, the owning team, " +
  "and what remediation is still outstanding. Keep working through all the files.";

const RESUME_PROMPT =
  "What did you establish about the incident before, and what remediation is still outstanding? " +
  "Name the failing module, its root cause, and the owning team.";

export const tasks: EvalTask[] = [
  {
    id: "continuity-kill-and-resume",
    domain: "continuity",
    prompt: RESUME_PROMPT,
    baseDifficulty: "hard",
    setup(workspaceDir) {
      seedCorpus(workspaceDir);
    },
    async run(context: TaskRunContext): Promise<OneShotResult> {
      const killed = await runJazzUntilKilled({
        prompt: FIRST_PROMPT,
        agentId: context.agentId,
        workspaceDir: context.workspaceDir,
        cassettePath: context.cassettePath,
        timeoutMs: context.timeoutMs,
        runId: `${context.runId}-phase1`,
        conversationId: CONVERSATION_ID,
        jazzHome: context.jazzHome,
        killWhen: (_event, seen) => sawCompaction(seen),
        hardTimeoutMs: context.timeoutMs,
      });

      // Voided, not failed: a run that died before compacting says nothing about whether
      // compaction preserves anything. Surfaced as a thrown error so the runner records
      // it as an error rather than silently as a wrong answer.
      if (!killed.killed || !sawCompaction(killed.events)) {
        throw new Error(
          `kill test void: run never reached compaction (${killed.events.length} events, killed=${killed.killed})`,
        );
      }

      return runJazzOnce({
        prompt: RESUME_PROMPT,
        agentId: context.agentId,
        workspaceDir: context.workspaceDir,
        cassettePath: context.cassettePath,
        timeoutMs: context.timeoutMs,
        runId: `${context.runId}-phase2`,
        conversationId: CONVERSATION_ID,
        jazzHome: context.jazzHome,
      });
    },
    check(result) {
      return continuityCheck(result, {
        mustRecall: [
          [PLANTED.failingModule],
          ["billing cycle boundary", "off-by-one", "cycle boundary"],
          [PLANTED.owner],
        ],
        // The successor must not report remediation as handled; the corpus says it was
        // never started, and claiming otherwise is exactly the optimism the preamble
        // warns about.
        mustNotClaim: [
          "remediation is complete",
          "already remediated",
          "issue is resolved",
          "fix has been applied",
        ],
        // Two of three is a pass: this is the lossy path by construction, and demanding
        // perfect recall through a real compaction would make the eval a coin flip.
        minRecallRatio: 2 / 3,
      });
    },
  },
];
