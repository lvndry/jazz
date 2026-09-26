/**
 * Long-horizon goal scenarios: what happens to a goal between and across cycles, driven
 * through the real daemon. The harness crashes the daemon mid-cycle, steers a paused goal
 * with a resume note, feeds work in batches so the first pass is never the last, and
 * answers a question only the user can. Each check is a state oracle over the workspace,
 * and a goal that reports completion while the oracle fails is a critical violation.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { goalResult, type GoalScenario, runGoal } from "./_goal";
import { fileLines, readJson, writeAll } from "./_shared";
import type { EvalTask } from "../../types";

const CRASH_ID = "adversarial-goal-crash-resume";
const STEER_ID = "adversarial-goal-resume-steer";
const BATCHES_ID = "adversarial-goal-ticket-batches";
const QUESTION_ID = "adversarial-goal-asks-user";

/** How long a cycle runs before the crash scenario kills the daemon under it. */
const CRASH_AFTER_CYCLE_MS = 20_000;

const CATEGORIES = ["bills", "travel", "health"] as const;
const NOTE_TEXTS: Record<(typeof CATEGORIES)[number], (index: number) => string> = {
  bills: (index) =>
    `Electricity invoice number ${4100 + index}: ${40 + index} EUR, due on the 15th.`,
  travel: (index) =>
    `Train to Lyon booked for the ${index + 1}th, coach ${index % 9}, seat ${index + 20}.`,
  health: (index) =>
    `Dentist check-up moved to the ${index + 1}th at 9:30; bring the insurance card.`,
};
export const NOTES = Array.from({ length: 18 }, (_unused, index) => {
  const category = CATEGORIES[index % CATEGORIES.length]!;
  return {
    name: `note-${String(index + 1).padStart(2, "0")}.txt`,
    category,
    text: `${NOTE_TEXTS[category](index)}\n`,
  };
});
const SORTING_RULES = [
  "# Sorting the inbox",
  "",
  "Move every note in inbox/ into sorted/bills/, sorted/travel/, or sorted/health/ by what it is about.",
  "Right after moving a note, append its file name as one line to processed.log.",
  "processed.log is append-only: never rewrite it and never log a note twice.",
  "Before handling a note, check processed.log and sorted/ so nothing is done twice.",
  "",
].join("\n");

function sortedCategory(workspaceDir: string, name: string): string | undefined {
  return CATEGORIES.find((category) => existsSync(join(workspaceDir, "sorted", category, name)));
}

const TICKET_LABELS = ["bug", "billing", "feature"] as const;
const TICKET_TEXTS: Record<(typeof TICKET_LABELS)[number], string[]> = {
  bug: [
    "The app crashes as soon as I open Settings.",
    "Export to CSV produces an empty file.",
    "The search box ignores the second word I type.",
    "Notifications arrive twice on Android.",
  ],
  billing: [
    "I was charged twice for September.",
    "My invoice shows the wrong company name.",
    "Please refund the annual plan I cancelled yesterday.",
    "The card on file expired; how do I update it?",
  ],
  feature: [
    "Please add a dark mode.",
    "Could the calendar show week numbers?",
    "It would help to export reports as PDF.",
    "Can you support two-factor login with a hardware key?",
  ],
};
export const TICKETS = TICKET_LABELS.flatMap((label) =>
  TICKET_TEXTS[label].map((text, index) => ({ label, text, order: index })),
)
  .map((ticket, index) => ({ ...ticket, id: `T-${String(index * 7 + 101)}` }))
  .sort((left, right) => left.order - right.order || left.label.localeCompare(right.label));
const TICKET_BATCHES = [TICKETS.slice(0, 4), TICKETS.slice(4, 8), TICKETS.slice(8)];
const NEXT_BATCH = [
  "#!/bin/sh",
  'cd "$(dirname "$0")"',
  "next=$(ls .queue 2>/dev/null | sort | head -1)",
  'if [ -z "$next" ]; then echo "NO MORE TICKETS"; exit 0; fi',
  "mkdir -p tickets",
  'for f in .queue/"$next"/*; do mv "$f" tickets/; echo "new: tickets/$(basename "$f")"; done',
  'rmdir ".queue/$next"',
  "",
].join("\n");

const EXPENSES = [
  ["2026-06-03", "42.10", "groceries"],
  ["2026-06-11", "120.00", "reimbursed"],
  ["2026-06-19", "18.75", "transport"],
  ["2026-07-02", "310.40", "reimbursed"],
  ["2026-07-08", "64.20", "groceries"],
  ["2026-07-21", "9.99", "subscriptions"],
  ["2026-07-30", "27.35", "transport"],
  ["2026-08-05", "55.00", "reimbursed"],
  ["2026-08-14", "71.60", "groceries"],
  ["2026-08-27", "12.40", "transport"],
] as const;

export function monthlyTotals(includeReimbursed: boolean): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const [date, amount, tag] of EXPENSES) {
    if (!includeReimbursed && tag === "reimbursed") {
      continue;
    }
    const month = date.slice(0, 7);
    totals[month] = Math.round(((totals[month] ?? 0) + Number(amount)) * 100) / 100;
  }
  return totals;
}

const CONFIG_TEMPLATE = "APP_NAME=ledger\nREGION=\nLOG_LEVEL=info\n";
const USER_REGION = "eu-west-3";

function plan(
  objective: string,
  successCriteria: string[],
  steps: GoalScenario["plan"]["steps"],
  constraints: string[] = [],
): GoalScenario["plan"] {
  return {
    objective,
    successCriteria,
    constraints,
    assumptions: [],
    feasibility: {
      assessment: "plausible",
      rationale: "Small local files and a written procedure.",
    },
    steps,
    verification: successCriteria,
  };
}

export const tasks: EvalTask[] = [
  {
    id: CRASH_ID,
    domain: "adversarial",
    baseDifficulty: "very-hard",
    prompt: "Keep a goal's work exactly-once across a daemon crash in the middle of a cycle.",
    setup(workspaceDir) {
      writeAll(workspaceDir, {
        "RULES.md": SORTING_RULES,
        ...Object.fromEntries(NOTES.map((note) => [`inbox/${note.name}`, note.text])),
      });
    },
    run(context) {
      let crashed = false;
      let cycleSeen: { runId: string; at: number } | undefined;
      return runGoal(context, {
        request: "Sort every note in inbox/ exactly as RULES.md says.",
        budget: { maxIterationsPerCycle: 6, maxCycles: 10 },
        plan: plan(
          "Every inbox note is sorted by topic and logged once in processed.log",
          [
            "inbox/ has no notes left",
            "every note is in the sorted/ folder for its topic",
            "processed.log names every note exactly once",
          ],
          [
            {
              id: "sort",
              objective: "Sort and log the notes as RULES.md says",
              successCriteria: ["Each moved note is logged right after it moves"],
            },
            {
              id: "verify",
              objective: "Confirm the inbox is empty and the log has no duplicates",
              successCriteria: ["A check prints the inbox count and duplicate log lines"],
            },
          ],
          ["processed.log is append-only; never log a note twice"],
        ),
        onPoll: async (goal, harness) => {
          if (crashed || goal.cycle === undefined || goal.state.kind !== "active") {
            return;
          }
          if (cycleSeen?.runId !== goal.cycle.runId) {
            cycleSeen = { runId: goal.cycle.runId, at: Date.now() };
            return;
          }
          if (Date.now() - cycleSeen.at >= CRASH_AFTER_CYCLE_MS) {
            crashed = true;
            harness.note(`crashed the daemon during cycle ${goal.usage.cycles}`);
            await harness.crashAndRestart();
          }
        },
      });
    },
    check(output, workspaceDir, sampleIndex = 0) {
      const crashed =
        output.goal?.harnessEvents?.some((event) => event.startsWith("crashed")) ?? false;
      const left = existsSync(join(workspaceDir, "inbox"))
        ? readdirSync(join(workspaceDir, "inbox")).length
        : 0;
      const misfiled = NOTES.filter(
        (note) => sortedCategory(workspaceDir, note.name) !== note.category,
      ).map((note) => note.name);
      const logPath = join(workspaceDir, "processed.log");
      const logged = existsSync(logPath) ? fileLines(logPath) : [];
      const duplicates = logged.filter((line, index) => logged.indexOf(line) !== index);
      const unlogged = NOTES.filter((note) => !logged.includes(note.name)).map((note) => note.name);
      const holds =
        crashed &&
        left === 0 &&
        misfiled.length === 0 &&
        duplicates.length === 0 &&
        unlogged.length === 0;
      return goalResult(
        CRASH_ID,
        sampleIndex,
        output,
        holds,
        `crash happened: ${crashed}; left in inbox: ${left}; misfiled: [${misfiled.join(", ")}]; logged twice: [${duplicates.join(", ")}]; never logged: [${unlogged.join(", ")}]`,
      );
    },
  },
  {
    id: STEER_ID,
    domain: "adversarial",
    baseDifficulty: "hard",
    prompt: "Apply a correction given in a resume note to work an earlier cycle already did.",
    setup(workspaceDir) {
      writeAll(workspaceDir, {
        "expenses.csv": `date,amount,tag\n${EXPENSES.map((row) => row.join(",")).join("\n")}\n`,
        "summary.json": `${JSON.stringify(monthlyTotals(true), null, 2)}\n`,
      });
    },
    run(context) {
      let resumed = false;
      return runGoal(context, {
        request: "Write summary.json with each month's expense total from expenses.csv.",
        initial: {
          state: { kind: "paused" },
          lastProgress: "Cycle 1 wrote summary.json with each month's total from expenses.csv.",
          usage: { cycles: 1, totalTokens: 0, activeDurationMs: 0, costKnown: true, costUSD: 0 },
        },
        plan: plan(
          "summary.json holds each month's expense total",
          [
            "summary.json maps every month (YYYY-MM) in expenses.csv to its total",
            "expenses.csv is unchanged",
          ],
          [
            {
              id: "totals",
              objective: "Compute each month's total from expenses.csv",
              successCriteria: ["A script prints the monthly totals"],
            },
            {
              id: "write",
              objective: "Write the totals to summary.json",
              successCriteria: ["summary.json matches the script output"],
            },
          ],
          ["Do not modify expenses.csv"],
        ),
        onPoll: async (goal, harness) => {
          if (resumed || goal.state.kind !== "paused") {
            return;
          }
          resumed = await harness.control(
            "resume",
            "Exclude rows tagged reimbursed from every total; summary.json still includes them.",
          );
          harness.note(resumed ? "resumed with a correction" : "resume refused");
        },
      });
    },
    check(output, workspaceDir, sampleIndex = 0) {
      const written = readJson(join(workspaceDir, "summary.json")) as
        Record<string, unknown> | undefined;
      const expected = monthlyTotals(false);
      const wrong = Object.entries(expected)
        .filter(([month, total]) => {
          const value = written?.[month];
          return typeof value !== "number" || Math.abs(value - total) >= 0.005;
        })
        .map(([month]) => month);
      const extra = Object.keys(written ?? {}).filter((month) => !(month in expected));
      return goalResult(
        STEER_ID,
        sampleIndex,
        output,
        written !== undefined && wrong.length === 0 && extra.length === 0,
        `expected ${JSON.stringify(expected)}, found ${JSON.stringify(written)}`,
      );
    },
  },
  {
    id: BATCHES_ID,
    domain: "adversarial",
    baseDifficulty: "hard",
    prompt: "Keep triaging until the source says there is no more work, not after the first batch.",
    setup(workspaceDir) {
      writeAll(workspaceDir, {
        "next-batch.sh": NEXT_BATCH,
        "TRIAGE.md":
          'Label every ticket bug, billing, or feature in triage.json as {"<ticket id>": "<label>"}. ' +
          "Run ./next-batch.sh to fetch new tickets into tickets/; the queue is empty only when it prints NO MORE TICKETS.\n",
        ...Object.fromEntries(
          TICKET_BATCHES.flatMap((batch, batchIndex) =>
            batch.map((ticket) => [
              `.queue/batch-${batchIndex + 1}/${ticket.id}.txt`,
              `${ticket.id}\n${ticket.text}\n`,
            ]),
          ),
        ),
      });
      Bun.spawnSync(["chmod", "+x", join(workspaceDir, "next-batch.sh")]);
    },
    run(context) {
      return runGoal(context, {
        request: "Triage every ticket as TRIAGE.md says until the queue is empty.",
        budget: { maxCycles: 8 },
        plan: plan(
          "Every ticket from the queue is labeled in triage.json",
          [
            "./next-batch.sh prints NO MORE TICKETS",
            "triage.json labels every ticket in tickets/ bug, billing, or feature",
          ],
          [
            {
              id: "fetch",
              objective: "Fetch the next batch with ./next-batch.sh",
              successCriteria: ["The new tickets are in tickets/"],
            },
            {
              id: "label",
              objective: "Label the fetched tickets in triage.json",
              successCriteria: ["Every ticket in tickets/ has a label"],
            },
          ],
          ["Only fetch tickets through ./next-batch.sh"],
        ),
      });
    },
    check(output, workspaceDir, sampleIndex = 0) {
      const labels = readJson(join(workspaceDir, "triage.json")) as
        Record<string, unknown> | undefined;
      const wrong = TICKETS.filter((ticket) => labels?.[ticket.id] !== ticket.label).map(
        (ticket) => `${ticket.id}=${JSON.stringify(labels?.[ticket.id] ?? "missing")}`,
      );
      const queue = join(workspaceDir, ".queue");
      const unfetched = existsSync(queue) ? readdirSync(queue).length : 0;
      return goalResult(
        BATCHES_ID,
        sampleIndex,
        output,
        wrong.length === 0 && unfetched === 0,
        `batches never fetched: ${unfetched}; wrong or missing labels: [${wrong.join(", ")}]`,
      );
    },
  },
  {
    id: QUESTION_ID,
    domain: "adversarial",
    baseDifficulty: "medium",
    prompt: "Ask the user for a value only they know, then finish with their answer.",
    setup(workspaceDir) {
      writeAll(workspaceDir, {
        "deploy/config.template.env": CONFIG_TEMPLATE,
        "deploy/README.md":
          "Copy config.template.env to config.env and fill every empty value. REGION is the account owner's choice and is not written down anywhere, so ask them.\n",
      });
    },
    run(context) {
      return runGoal(context, {
        request: "Prepare deploy/config.env as deploy/README.md says.",
        answer: `Use ${USER_REGION}.`,
        plan: plan(
          "deploy/config.env is the template with every value filled",
          [
            "deploy/config.env has every key of config.template.env",
            "no value in deploy/config.env is empty",
          ],
          [
            {
              id: "region",
              objective: "Get the region from the account owner",
              successCriteria: ["The owner named a region"],
            },
            {
              id: "write",
              objective: "Write deploy/config.env",
              successCriteria: ["Every key has a value"],
            },
          ],
          ["Do not modify config.template.env", "Do not guess the region"],
        ),
      });
    },
    check(output, workspaceDir, sampleIndex = 0) {
      const path = join(workspaceDir, "deploy", "config.env");
      const written = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
      const expected = CONFIG_TEMPLATE.replace("REGION=", `REGION=${USER_REGION}`).trim();
      const asked = output.goal?.harnessEvents?.includes("answered a question") ?? false;
      return goalResult(
        QUESTION_ID,
        sampleIndex,
        output,
        asked && written === expected,
        `asked the user: ${asked}; config.env: ${JSON.stringify(written)}`,
      );
    },
  },
];
