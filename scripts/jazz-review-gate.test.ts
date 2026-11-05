import { describe, expect, test } from "bun:test";

import {
  REVIEW_GATE_LIMITS,
  buildLimitComment,
  evaluateReviewLimits,
  hasReviewForHead,
  parseReviewRunTitle,
  selectSupersededRunIds,
  type WorkflowRun,
} from "./jazz-review-gate";

const NOW = new Date("2026-11-05T12:00:00Z");
const OLD_SHA = "aaaaaaa1";
const NEW_SHA = "bbbbbbb2";

function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

let nextRunId = 1000;

function run(
  displayTitle: string,
  status: string,
  conclusion: string | null,
  createdMinutesAgo: number,
): WorkflowRun {
  nextRunId += 1;
  return {
    id: nextRunId,
    status,
    conclusion,
    created_at: minutesAgo(createdMinutesAgo),
    display_title: displayTitle,
  };
}

describe("parseReviewRunTitle", () => {
  test("reads pull request, kind and head sha", () => {
    expect(parseReviewRunTitle(`Jazz code-review #42 [auto] ${OLD_SHA}`)).toEqual({
      pullRequestNumber: 42,
      kind: "auto",
      headSha: OLD_SHA,
    });
  });

  test("accepts a manual title without a sha", () => {
    expect(parseReviewRunTitle("Jazz code-review #7 [manual]")).toEqual({
      pullRequestNumber: 7,
      kind: "manual",
      headSha: "",
    });
  });

  test("ignores assistant runs and other workflows' titles", () => {
    expect(parseReviewRunTitle("Jazz assistant #42 [manual]")).toBeNull();
    expect(parseReviewRunTitle("Jazz issue_comment")).toBeNull();
    expect(parseReviewRunTitle("fix: something")).toBeNull();
  });
});

describe("selectSupersededRunIds", () => {
  const target = { pullRequestNumber: 42, headSha: NEW_SHA };

  test("selects queued automatic runs of the same pull request on an older commit", () => {
    const pending = run(`Jazz code-review #42 [auto] ${OLD_SHA}`, "pending", null, 20);
    const queued = run(`Jazz code-review #42 [auto] ${OLD_SHA}`, "queued", null, 15);
    expect(selectSupersededRunIds([pending, queued], target)).toEqual([pending.id, queued.id]);
  });

  test("never selects a run that already started", () => {
    const started = run(`Jazz code-review #42 [auto] ${OLD_SHA}`, "in_progress", null, 5);
    const finished = run(`Jazz code-review #42 [auto] ${OLD_SHA}`, "completed", "success", 90);
    expect(selectSupersededRunIds([started, finished], target)).toEqual([]);
  });

  test("never selects another pull request's run", () => {
    const otherPullRequest = run(`Jazz code-review #43 [auto] ${OLD_SHA}`, "pending", null, 5);
    expect(selectSupersededRunIds([otherPullRequest], target)).toEqual([]);
  });

  test("never selects the run for the newest commit", () => {
    const newest = run(`Jazz code-review #42 [auto] ${NEW_SHA}`, "pending", null, 1);
    expect(selectSupersededRunIds([newest], target)).toEqual([]);
  });

  test("never selects manual, comment-triggered or assistant runs", () => {
    const manual = run(`Jazz code-review #42 [manual] ${OLD_SHA}`, "pending", null, 5);
    const comment = run("Jazz code-review #42 [manual]", "pending", null, 5);
    const assistant = run("Jazz assistant #42 [manual]", "pending", null, 5);
    const unrelated = run("Jazz issue_comment", "pending", null, 5);
    expect(selectSupersededRunIds([manual, comment, assistant, unrelated], target)).toEqual([]);
  });
});

describe("hasReviewForHead", () => {
  const target = { pullRequestNumber: 42, headSha: NEW_SHA };

  test("is true for a queued, running or successful review of the same commit", () => {
    for (const [status, conclusion] of [
      ["pending", null],
      ["in_progress", null],
      ["completed", "success"],
    ] as const) {
      const existing = run(`Jazz code-review #42 [auto] ${NEW_SHA}`, status, conclusion, 3);
      expect(hasReviewForHead([existing], target)).toBe(true);
    }
  });

  test("is false for a cancelled or failed review, another commit or another pull request", () => {
    const cancelled = run(`Jazz code-review #42 [auto] ${NEW_SHA}`, "completed", "cancelled", 3);
    const failed = run(`Jazz code-review #42 [auto] ${NEW_SHA}`, "completed", "failure", 3);
    const otherCommit = run(`Jazz code-review #42 [auto] ${OLD_SHA}`, "pending", null, 3);
    const otherPullRequest = run(`Jazz code-review #9 [auto] ${NEW_SHA}`, "pending", null, 3);
    expect(hasReviewForHead([cancelled, failed, otherCommit, otherPullRequest], target)).toBe(
      false,
    );
  });
});

describe("evaluateReviewLimits", () => {
  const evaluateAuto = (runs: WorkflowRun[]) =>
    evaluateReviewLimits({ runs, kind: "auto", pullRequestNumber: 42, now: NOW });

  test("allows when nothing was reviewed recently", () => {
    expect(evaluateAuto([]).allowed).toBe(true);
  });

  test("blocks within the minimum gap of the previous automatic review of the pull request", () => {
    const recent = run(`Jazz code-review #42 [auto] ${OLD_SHA}`, "completed", "success", 4);
    const verdict = evaluateAuto([recent]);
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toBe("minimum-gap");
  });

  test("allows once the minimum gap has passed", () => {
    const earlier = run(
      `Jazz code-review #42 [auto] ${OLD_SHA}`,
      "completed",
      "success",
      REVIEW_GATE_LIMITS.minimumGapMinutes + 1,
    );
    expect(evaluateAuto([earlier]).allowed).toBe(true);
  });

  test("blocks at the per pull request budget and ignores runs outside the window", () => {
    const inWindow = Array.from(
      { length: REVIEW_GATE_LIMITS.perPullRequestMaxReviews },
      (_, index) =>
        run(`Jazz code-review #42 [auto] ${OLD_SHA}`, "completed", "success", 60 * (index + 2)),
    );
    const verdict = evaluateAuto(inWindow);
    expect(verdict.allowed === false && verdict.reason).toBe("pull-request-budget");

    const outsideWindow = inWindow.map((entry) => ({ ...entry, created_at: minutesAgo(60 * 25) }));
    expect(evaluateAuto(outsideWindow).allowed).toBe(true);
  });

  test("does not count cancelled or skipped runs, another pull request, or the comment-triggered runs", () => {
    const uncounted = [
      run(`Jazz code-review #42 [auto] ${OLD_SHA}`, "completed", "cancelled", 30),
      run(`Jazz code-review #42 [auto] ${OLD_SHA}`, "completed", "skipped", 30),
      run(`Jazz code-review #99 [auto] ${OLD_SHA}`, "completed", "success", 3),
      run("Jazz code-review #42 [manual]", "completed", "success", 3),
    ];
    expect(evaluateAuto(uncounted).allowed).toBe(true);
  });

  test("blocks automatic and manual reviews at the global hourly cap", () => {
    const flood = Array.from({ length: REVIEW_GATE_LIMITS.globalMaxReviews }, (_, index) =>
      run(`Jazz code-review #${100 + index} [auto] ${OLD_SHA}`, "pending", null, 5 + index),
    );
    const auto = evaluateAuto(flood);
    expect(auto.allowed === false && auto.reason).toBe("global");
    const manual = evaluateReviewLimits({
      runs: flood,
      kind: "manual",
      pullRequestNumber: 42,
      now: NOW,
    });
    expect(manual.allowed === false && manual.reason).toBe("global");
  });

  test("manual reviews bypass the per pull request budget and gap", () => {
    const recent = Array.from({ length: REVIEW_GATE_LIMITS.perPullRequestMaxReviews }, () =>
      run(`Jazz code-review #42 [auto] ${OLD_SHA}`, "completed", "success", 2),
    );
    const verdict = evaluateReviewLimits({
      runs: recent,
      kind: "manual",
      pullRequestNumber: 42,
      now: NOW,
    });
    expect(verdict.allowed).toBe(true);
  });

  test("a run does not count against itself", () => {
    const flood = Array.from({ length: REVIEW_GATE_LIMITS.globalMaxReviews }, (_, index) =>
      run(`Jazz code-review #${100 + index} [manual]`, "in_progress", null, 5 + index),
    );
    const own = flood[0];
    if (own === undefined) {
      throw new Error("fixture");
    }
    const verdict = evaluateReviewLimits({
      runs: flood,
      kind: "manual",
      pullRequestNumber: 42,
      now: NOW,
      excludeRunId: own.id,
    });
    expect(verdict.allowed).toBe(true);
  });
});

describe("buildLimitComment", () => {
  test("carries the marker used to update one comment per pull request", () => {
    const verdict = { allowed: false, reason: "global", message: "Too many." } as const;
    expect(buildLimitComment(verdict, "auto").startsWith("<!-- jazz-review-limit -->")).toBe(true);
    expect(buildLimitComment(verdict, "auto")).toContain("/jazz-review");
  });
});
