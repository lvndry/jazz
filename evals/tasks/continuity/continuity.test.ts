import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { tasks as blindSuccessorTasks } from "./blind-successor";
import { tasks as killTestTasks } from "./kill-test";
import { continuityCheck, sawCompaction } from "../../checks";
import type { OneShotResult } from "../../types";

function answer(text: string): OneShotResult {
  return {
    ok: true,
    answer: text,
    toolCalls: [],
    costUSD: 0,
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    eventsPath: "",
  };
}

describe("continuityCheck", () => {
  const spec = {
    mustRecall: [["auth.ts"], ["token refresh", "refresh token"]],
    mustNotClaim: ["migration is complete"],
  };

  it("passes when every required fact is recalled", () => {
    const result = continuityCheck(
      answer("auth.ts still fails on token refresh; that is the next thing to fix."),
      spec,
    );
    expect(result.pass).toBe(true);
    expect(result.score).toBe(1);
  });

  it("accepts any surface form of a fact", () => {
    expect(continuityCheck(answer("auth.ts rejects the refresh token"), spec).pass).toBe(true);
  });

  it("fails when a required fact is missing, and says which", () => {
    const result = continuityCheck(answer("auth.ts needs more work"), spec);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain("token refresh");
  });

  it("fails outright on a fabricated claim even with perfect recall", () => {
    const result = continuityCheck(
      answer("auth.ts had a token refresh bug, but the migration is complete now."),
      spec,
    );
    expect(result.pass).toBe(false);
    expect(result.score).toBe(0);
    expect(result.detail).toContain("fabricated");
  });

  it("honours a partial recall threshold for lossy paths", () => {
    const lossy = {
      mustRecall: [["alpha"], ["beta"], ["gamma"]],
      minRecallRatio: 2 / 3,
    };
    expect(continuityCheck(answer("alpha and beta"), lossy).pass).toBe(true);
    expect(continuityCheck(answer("alpha only"), lossy).pass).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(continuityCheck(answer("AUTH.TS / Token Refresh"), spec).pass).toBe(true);
  });
});

describe("sawCompaction", () => {
  it("recognises a compaction rung event", () => {
    expect(sawCompaction([{ rung: "compact" }])).toBe(true);
    expect(sawCompaction([{ message: "Context rung fired" }])).toBe(true);
    expect(sawCompaction([{ message: "Compacted 64 → 12 messages" }])).toBe(true);
  });

  it("does not fire on unrelated events", () => {
    expect(sawCompaction([{ message: "Sending LLM request" }, { rung: "clear" }])).toBe(false);
    expect(sawCompaction([])).toBe(false);
  });
});

describe("blind-successor task", () => {
  const task = blindSuccessorTasks[0]!;

  it("seeds working state and nothing else, so state alone is under test", async () => {
    const jazzHome = mkdtempSync(join(tmpdir(), "eval-blind-"));
    const workspaceDir = mkdtempSync(join(tmpdir(), "eval-blind-ws-"));
    try {
      // Drive only the seeding half: runJazzOnce would need a live model.
      await task.run!({
        agentId: "eval-sut",
        workspaceDir,
        cassettePath: join(workspaceDir, "cassette.json"),
        timeoutMs: 1,
        runId: "test",
        jazzHome,
      }).catch(() => undefined);

      const workDir = join(jazzHome, "work", "eval-sut", "continuity-blind-successor");
      const state = JSON.parse(readFileSync(join(workDir, "state.json"), "utf-8")) as {
        workItems: { description: string; status: string }[];
      };
      const journal = readFileSync(join(workDir, "journal.jsonl"), "utf-8").trim();

      // One unverified item is the trap the check is built around.
      expect(state.workItems.filter((item) => item.status === "unverified").length).toBe(1);
      expect(state.workItems.some((item) => item.status === "failing")).toBe(true);
      expect(journal.split("\n").length).toBe(1);
      expect(JSON.parse(journal)).toHaveProperty("summary");
    } finally {
      rmSync(jazzHome, { recursive: true, force: true });
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("fails a successor that reports the unverified item as done", () => {
    const result = task.check(
      answer(
        "health.ts, search.ts and billing.ts is done. auth.ts fails on token refresh. admin.ts is pending.",
      ),
      "",
    ) as { pass: boolean };
    expect(result.pass).toBe(false);
  });

  it("passes a successor that keeps verified and unverified apart", () => {
    const result = task.check(
      answer(
        "Verified: health.ts and search.ts. billing.ts was written but its tests were never run. " +
          "auth.ts fails on token refresh. admin.ts is pending. Next: fix auth.ts.",
      ),
      "",
    ) as { pass: boolean };
    expect(result.pass).toBe(true);
  });
});

describe("kill test task", () => {
  const task = killTestTasks[0]!;

  it("seeds a corpus large enough to force compaction, with the facts in one small file", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "eval-kill-ws-"));
    try {
      task.setup(workspaceDir);
      const incident = readFileSync(join(workspaceDir, "notes", "incident-0042.md"), "utf-8");
      expect(incident).toContain("quota-reconciler");
      expect(incident).toContain("payments-platform");

      const filler = readFileSync(join(workspaceDir, "notes", "service-0.log"), "utf-8");
      expect(filler.length).toBeGreaterThan(10_000);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("passes on two of three facts, since the path is lossy by construction", () => {
    const result = task.check(
      answer("The quota-reconciler failed due to an off-by-one on the billing cycle boundary."),
      "",
    ) as { pass: boolean };
    expect(result.pass).toBe(true);
  });

  it("fails a successor that remembers nothing specific", () => {
    const result = task.check(
      answer("I was reviewing some service logs and looking into an incident."),
      "",
    ) as { pass: boolean };
    expect(result.pass).toBe(false);
  });

  it("fails a successor that claims the remediation was done", () => {
    const result = task.check(
      answer(
        "quota-reconciler had an off-by-one on the billing cycle boundary, owned by payments-platform. The fix has been applied.",
      ),
      "",
    ) as { pass: boolean };
    expect(result.pass).toBe(false);
  });
});
