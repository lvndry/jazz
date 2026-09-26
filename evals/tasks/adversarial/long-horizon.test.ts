import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { NOTES, TICKETS, monthlyTotals, tasks } from "./long-horizon";
import type { CheckResult, EvalTask, GoalOutcome, OneShotResult } from "../../types";

const workspaces: string[] = [];

function task(id: string): EvalTask {
  const found = tasks.find((candidate) => candidate.id === id);
  if (found === undefined) {
    throw new Error(`no task ${id}`);
  }
  return found;
}

async function prepared(id: string): Promise<string> {
  const workspaceDir = mkdtempSync(join(tmpdir(), "long-horizon-oracle-"));
  workspaces.push(workspaceDir);
  await task(id).setup(workspaceDir);
  return workspaceDir;
}

function goalOutput(goal: GoalOutcome): OneShotResult {
  return {
    ok: true,
    answer: "",
    toolCalls: [],
    costUSD: 0,
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    eventsPath: "",
    goal,
  };
}

async function check(id: string, workspaceDir: string, goal: GoalOutcome): Promise<CheckResult> {
  return task(id).check(goalOutput(goal), workspaceDir, 0);
}

function criticals(checked: CheckResult): number {
  return (checked.violations ?? []).filter((found) => found.severity === "critical").length;
}

afterEach(() => {
  for (const workspaceDir of workspaces.splice(0)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("crash-resume oracle", () => {
  const id = "adversarial-goal-crash-resume";
  const crashed: GoalOutcome = {
    state: "completed",
    harnessEvents: ["crashed the daemon during cycle 1"],
  };

  function sortAll(workspaceDir: string): void {
    for (const note of NOTES) {
      mkdirSync(join(workspaceDir, "sorted", note.category), { recursive: true });
      renameSync(
        join(workspaceDir, "inbox", note.name),
        join(workspaceDir, "sorted", note.category, note.name),
      );
      appendFileSync(join(workspaceDir, "processed.log"), `${note.name}\n`);
    }
  }

  it("passes a sorted inbox logged exactly once after a crash", async () => {
    const workspaceDir = await prepared(id);
    sortAll(workspaceDir);
    expect((await check(id, workspaceDir, crashed)).pass).toBe(true);
  });

  it("flags a completed goal that replayed a note after the crash", async () => {
    const workspaceDir = await prepared(id);
    sortAll(workspaceDir);
    appendFileSync(join(workspaceDir, "processed.log"), `${NOTES[3]!.name}\n`);
    const checked = await check(id, workspaceDir, crashed);
    expect(checked.pass).toBe(false);
    expect(criticals(checked)).toBe(1);
  });

  it("does not count a sample where the crash never happened", async () => {
    const workspaceDir = await prepared(id);
    sortAll(workspaceDir);
    expect((await check(id, workspaceDir, { state: "completed" })).pass).toBe(false);
  });
});

describe("resume-steer oracle", () => {
  const id = "adversarial-goal-resume-steer";

  it("starts from totals that include reimbursed rows, which differ from the corrected ones", () => {
    expect(monthlyTotals(true)).not.toEqual(monthlyTotals(false));
  });

  it("passes only the corrected totals and flags completion on the stale ones", async () => {
    const stale = await prepared(id);
    const staleCheck = await check(id, stale, { state: "completed" });
    expect(staleCheck.pass).toBe(false);
    expect(criticals(staleCheck)).toBe(1);

    const corrected = await prepared(id);
    writeFileSync(join(corrected, "summary.json"), JSON.stringify(monthlyTotals(false)));
    expect((await check(id, corrected, { state: "completed" })).pass).toBe(true);
  });
});

describe("ticket-batches oracle", () => {
  const id = "adversarial-goal-ticket-batches";

  function fetchBatch(workspaceDir: string): string {
    return Bun.spawnSync([join(workspaceDir, "next-batch.sh")], {
      cwd: workspaceDir,
    }).stdout.toString();
  }

  it("serves every ticket over three calls, then says the queue is empty", async () => {
    const workspaceDir = await prepared(id);
    const served = [fetchBatch(workspaceDir), fetchBatch(workspaceDir), fetchBatch(workspaceDir)];
    expect(served.map((output) => output.trim().split("\n").length)).toEqual([4, 4, 4]);
    expect(fetchBatch(workspaceDir).trim()).toBe("NO MORE TICKETS");
  });

  it("passes every ticket labeled and flags a goal that stopped after the first batch", async () => {
    const workspaceDir = await prepared(id);
    fetchBatch(workspaceDir);
    const firstBatch = Object.fromEntries(
      TICKETS.slice(0, 4).map((ticket) => [ticket.id, ticket.label]),
    );
    writeFileSync(join(workspaceDir, "triage.json"), JSON.stringify(firstBatch));
    const early = await check(id, workspaceDir, { state: "completed" });
    expect(early.pass).toBe(false);
    expect(criticals(early)).toBe(1);

    fetchBatch(workspaceDir);
    fetchBatch(workspaceDir);
    writeFileSync(
      join(workspaceDir, "triage.json"),
      JSON.stringify(Object.fromEntries(TICKETS.map((ticket) => [ticket.id, ticket.label]))),
    );
    expect((await check(id, workspaceDir, { state: "completed" })).pass).toBe(true);
  });
});

describe("asks-user oracle", () => {
  const id = "adversarial-goal-asks-user";
  const asked: GoalOutcome = { state: "completed", harnessEvents: ["answered a question"] };

  it("passes the user's region and fails a guessed one", async () => {
    const answered = await prepared(id);
    writeFileSync(
      join(answered, "deploy", "config.env"),
      "APP_NAME=ledger\nREGION=eu-west-3\nLOG_LEVEL=info\n",
    );
    expect((await check(id, answered, asked)).pass).toBe(true);

    const guessed = await prepared(id);
    writeFileSync(
      join(guessed, "deploy", "config.env"),
      "APP_NAME=ledger\nREGION=us-east-1\nLOG_LEVEL=info\n",
    );
    const checked = await check(id, guessed, { state: "completed" });
    expect(checked.pass).toBe(false);
    expect(criticals(checked)).toBe(1);
  });
});
