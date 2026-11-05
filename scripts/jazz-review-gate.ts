/**
 * Gate in front of the Jazz code review. Runs without any secret, using only the automatic
 * GITHUB_TOKEN, so waiting here never holds a slot in the repository-wide ChatGPT credential
 * queue of jazz.yml.
 *
 * Modes (first argument):
 * - `gate`: a pull request was pushed. Wait out the debounce, then supersede older queued
 *   automatic reviews, enforce the review limits and dispatch jazz.yml's code-review job.
 * - `close`: a pull request was closed or merged. Cancel its queued automatic reviews.
 * - `global-check`: a manual review is about to run inside jazz.yml. Enforce only the global
 *   cap and report the verdict through the `review_allowed` step output.
 *
 * Review runs are recognised from their run name, set by `run-name` in jazz.yml:
 * `Jazz code-review #<pull request> [auto|manual] <head sha>`. Every count below is derived
 * from the Jazz workflow's runs, so the limits survive restarts and need no stored state.
 */

import { appendFileSync, readFileSync } from "node:fs";

export const REVIEW_GATE_LIMITS = {
  debounceSeconds: 180,
  perPullRequestMaxReviews: 6,
  perPullRequestWindowHours: 24,
  minimumGapMinutes: 10,
  globalMaxReviews: 8,
  globalWindowMinutes: 60,
} as const;

export type ReviewGateLimits = {
  readonly [Key in keyof typeof REVIEW_GATE_LIMITS]: number;
};

export type ReviewKind = "auto" | "manual";

export interface WorkflowRun {
  readonly id: number;
  readonly status: string | null;
  readonly conclusion: string | null;
  readonly created_at: string;
  readonly display_title: string;
}

export interface ParsedReviewRun {
  readonly pullRequestNumber: number;
  readonly kind: ReviewKind;
  readonly headSha: string;
}

export type LimitVerdict =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: "global" | "pull-request-budget" | "minimum-gap";
      readonly message: string;
    };

const NOT_STARTED_STATUSES = new Set(["queued", "pending", "waiting", "requested"]);
const ACTIVE_STATUSES = new Set([...NOT_STARTED_STATUSES, "in_progress"]);
const REVIEW_RUN_TITLE = /^Jazz code-review #(\d+) \[(auto|manual)\](?: ([0-9a-f]{7,40}))?\s*$/;
const MILLISECONDS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;

export const LIMIT_COMMENT_MARKER = "<!-- jazz-review-limit -->";

export function parseReviewRunTitle(title: string): ParsedReviewRun | null {
  const match = REVIEW_RUN_TITLE.exec(title);
  if (match === null) {
    return null;
  }
  return {
    pullRequestNumber: Number(match[1]),
    kind: match[2] === "auto" ? "auto" : "manual",
    headSha: match[3] ?? "",
  };
}

function isCountedReview(run: WorkflowRun): boolean {
  return (
    parseReviewRunTitle(run.display_title) !== null &&
    run.conclusion !== "cancelled" &&
    run.conclusion !== "skipped"
  );
}

/**
 * Automatic reviews of this pull request that have not started and target another commit.
 * Started runs are never selected: cancelling one could kill it after it consumed the rotating
 * ChatGPT refresh token and before the rotated credential was persisted. Manual and
 * comment-triggered reviews are explicit requests and are never selected.
 */
export function selectSupersededRunIds(
  runs: readonly WorkflowRun[],
  target: { readonly pullRequestNumber: number; readonly headSha: string },
): number[] {
  return runs
    .filter((run) => {
      const parsed = parseReviewRunTitle(run.display_title);
      return (
        parsed !== null &&
        parsed.kind === "auto" &&
        parsed.pullRequestNumber === target.pullRequestNumber &&
        parsed.headSha !== target.headSha &&
        run.status !== null &&
        NOT_STARTED_STATUSES.has(run.status)
      );
    })
    .map((run) => run.id);
}

/** True when an automatic review of this exact commit is already queued, running or done. */
export function hasReviewForHead(
  runs: readonly WorkflowRun[],
  target: { readonly pullRequestNumber: number; readonly headSha: string },
): boolean {
  return runs.some((run) => {
    const parsed = parseReviewRunTitle(run.display_title);
    if (
      parsed === null ||
      parsed.kind !== "auto" ||
      parsed.pullRequestNumber !== target.pullRequestNumber ||
      parsed.headSha !== target.headSha
    ) {
      return false;
    }
    return (run.status !== null && ACTIVE_STATUSES.has(run.status)) || run.conclusion === "success";
  });
}

export function evaluateReviewLimits(input: {
  readonly runs: readonly WorkflowRun[];
  readonly kind: ReviewKind;
  readonly pullRequestNumber: number;
  readonly now: Date;
  readonly limits?: ReviewGateLimits;
  readonly excludeRunId?: number;
}): LimitVerdict {
  const limits = input.limits ?? REVIEW_GATE_LIMITS;
  const nowMilliseconds = input.now.getTime();
  const counted = input.runs.filter((run) => run.id !== input.excludeRunId && isCountedReview(run));
  const ageMinutes = (run: WorkflowRun): number =>
    (nowMilliseconds - Date.parse(run.created_at)) / MILLISECONDS_PER_MINUTE;

  const inGlobalWindow = counted.filter((run) => ageMinutes(run) <= limits.globalWindowMinutes);
  if (inGlobalWindow.length >= limits.globalMaxReviews) {
    return {
      allowed: false,
      reason: "global",
      message: `${inGlobalWindow.length} reviews already started across the repository in the last ${limits.globalWindowMinutes} minutes (limit ${limits.globalMaxReviews}).`,
    };
  }

  if (input.kind === "manual") {
    return { allowed: true };
  }

  const pullRequestReviews = counted.filter((run) => {
    const parsed = parseReviewRunTitle(run.display_title);
    return (
      parsed !== null &&
      parsed.kind === "auto" &&
      parsed.pullRequestNumber === input.pullRequestNumber
    );
  });

  const inBudgetWindow = pullRequestReviews.filter(
    (run) => ageMinutes(run) <= limits.perPullRequestWindowHours * MINUTES_PER_HOUR,
  );
  if (inBudgetWindow.length >= limits.perPullRequestMaxReviews) {
    return {
      allowed: false,
      reason: "pull-request-budget",
      message: `${inBudgetWindow.length} automatic reviews of this pull request in the last ${limits.perPullRequestWindowHours} hours (limit ${limits.perPullRequestMaxReviews}).`,
    };
  }

  const tooRecent = pullRequestReviews.some((run) => ageMinutes(run) < limits.minimumGapMinutes);
  if (tooRecent) {
    return {
      allowed: false,
      reason: "minimum-gap",
      message: `The previous automatic review of this pull request started less than ${limits.minimumGapMinutes} minutes ago.`,
    };
  }

  return { allowed: true };
}

export function buildLimitComment(
  verdict: Extract<LimitVerdict, { allowed: false }>,
  kind: ReviewKind,
): string {
  const closing =
    kind === "auto"
      ? "Comment `/jazz-review` to run one on demand."
      : "Comment `/jazz-review` again once the window has passed.";
  return [
    LIMIT_COMMENT_MARKER,
    "## Jazz Code Review",
    "",
    `${kind === "auto" ? "Automatic review" : "Review"} skipped. ${verdict.message}`,
    "",
    closing,
  ].join("\n");
}

interface GateContext {
  readonly token: string;
  readonly repository: string;
  readonly apiUrl: string;
}

async function githubRequest<Result>(
  context: GateContext,
  method: string,
  path: string,
  body?: unknown,
): Promise<Result> {
  const response = await fetch(`${context.apiUrl}/repos/${context.repository}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${context.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} failed with ${response.status}`);
  }
  if (response.status === 204) {
    return undefined as Result;
  }
  const text = await response.text();
  return (text === "" ? undefined : JSON.parse(text)) as Result;
}

const RUN_PAGE_SIZE = 100;
const MAX_RUN_PAGES = 10;

async function listRecentRuns(
  context: GateContext,
  now: Date,
  limits: ReviewGateLimits,
): Promise<WorkflowRun[]> {
  const windowHours = Math.max(
    limits.perPullRequestWindowHours,
    limits.globalWindowMinutes / MINUTES_PER_HOUR,
  );
  const since = new Date(now.getTime() - windowHours * MINUTES_PER_HOUR * MILLISECONDS_PER_MINUTE);
  const runs: WorkflowRun[] = [];
  for (let page = 1; page <= MAX_RUN_PAGES; page += 1) {
    const query = new URLSearchParams({
      per_page: String(RUN_PAGE_SIZE),
      page: String(page),
      created: `>=${since.toISOString()}`,
    });
    const result = await githubRequest<{ workflow_runs: WorkflowRun[] }>(
      context,
      "GET",
      `/actions/workflows/jazz.yml/runs?${query.toString()}`,
    );
    runs.push(...result.workflow_runs);
    if (result.workflow_runs.length < RUN_PAGE_SIZE) {
      break;
    }
  }
  return runs;
}

interface IssueComment {
  readonly id: number;
  readonly body?: string | null;
}

async function findLimitComment(
  context: GateContext,
  pullRequestNumber: number,
): Promise<IssueComment | null> {
  for (let page = 1; page <= MAX_RUN_PAGES; page += 1) {
    const comments = await githubRequest<IssueComment[]>(
      context,
      "GET",
      `/issues/${pullRequestNumber}/comments?per_page=${RUN_PAGE_SIZE}&page=${page}`,
    );
    const found = comments.find((comment) => comment.body?.startsWith(LIMIT_COMMENT_MARKER));
    if (found !== undefined) {
      return found;
    }
    if (comments.length < RUN_PAGE_SIZE) {
      return null;
    }
  }
  return null;
}

async function upsertLimitComment(
  context: GateContext,
  pullRequestNumber: number,
  verdict: Extract<LimitVerdict, { allowed: false }>,
  kind: ReviewKind,
): Promise<void> {
  const body = buildLimitComment(verdict, kind);
  const existing = await findLimitComment(context, pullRequestNumber);
  if (existing === null) {
    await githubRequest(context, "POST", `/issues/${pullRequestNumber}/comments`, { body });
    console.log(`Posted limit comment on #${pullRequestNumber}.`);
    return;
  }
  await githubRequest(context, "PATCH", `/issues/comments/${existing.id}`, { body });
  console.log(`Updated limit comment ${existing.id} on #${pullRequestNumber}.`);
}

async function removeLimitComment(context: GateContext, pullRequestNumber: number): Promise<void> {
  const existing = await findLimitComment(context, pullRequestNumber);
  if (existing !== null) {
    await githubRequest(context, "DELETE", `/issues/comments/${existing.id}`);
    console.log(`Removed stale limit comment ${existing.id} on #${pullRequestNumber}.`);
  }
}

interface PullRequestState {
  readonly state: string;
  readonly draft: boolean;
  readonly head: { readonly sha: string };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function buildContext(): GateContext {
  return {
    token: requiredEnvironment("GITHUB_TOKEN"),
    repository: requiredEnvironment("GITHUB_REPOSITORY"),
    apiUrl: process.env["GITHUB_API_URL"] ?? "https://api.github.com",
  };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runGate(): Promise<void> {
  const context = buildContext();
  const event = JSON.parse(readFileSync(requiredEnvironment("GITHUB_EVENT_PATH"), "utf8")) as {
    pull_request: { number: number; head: { sha: string } };
  };
  const pullRequestNumber = event.pull_request.number;
  const eventHeadSha = event.pull_request.head.sha;
  console.log(
    `Gate for #${pullRequestNumber} at ${eventHeadSha}: waiting ${REVIEW_GATE_LIMITS.debounceSeconds}s.`,
  );
  await sleep(REVIEW_GATE_LIMITS.debounceSeconds * 1000);

  const pullRequest = await githubRequest<PullRequestState>(
    context,
    "GET",
    `/pulls/${pullRequestNumber}`,
  );
  if (pullRequest.state !== "open" || pullRequest.draft) {
    console.log(
      `Skip: #${pullRequestNumber} is ${pullRequest.state}${pullRequest.draft ? " and a draft" : ""}.`,
    );
    return;
  }
  if (pullRequest.head.sha !== eventHeadSha) {
    console.log(`Skip: head moved to ${pullRequest.head.sha}; the newer push has its own gate.`);
    return;
  }

  const now = new Date();
  const runs = await listRecentRuns(context, now, REVIEW_GATE_LIMITS);
  const target = { pullRequestNumber, headSha: eventHeadSha };
  if (hasReviewForHead(runs, target)) {
    console.log(`Skip: an automatic review of ${eventHeadSha} already exists.`);
    return;
  }

  const supersededRunIds = selectSupersededRunIds(runs, target);
  const remainingRuns = runs.filter((run) => !supersededRunIds.includes(run.id));
  const verdict = evaluateReviewLimits({
    runs: remainingRuns,
    kind: "auto",
    pullRequestNumber,
    now,
  });
  if (!verdict.allowed) {
    console.log(`Skip: ${verdict.reason}. ${verdict.message}`);
    await upsertLimitComment(context, pullRequestNumber, verdict, "auto");
    return;
  }

  for (const runId of supersededRunIds) {
    try {
      await githubRequest(context, "POST", `/actions/runs/${runId}/cancel`);
      console.log(`Cancelled queued older review run ${runId}.`);
    } catch (error) {
      console.log(`Could not cancel run ${runId}: ${(error as Error).message}`);
    }
  }

  await removeLimitComment(context, pullRequestNumber);
  await githubRequest(context, "POST", "/actions/workflows/jazz.yml/dispatches", {
    ref: requiredEnvironment("JAZZ_DEFAULT_BRANCH"),
    inputs: {
      job: "code-review",
      pull_request_number: String(pullRequestNumber),
      automatic: "true",
      head_sha: eventHeadSha,
    },
  });
  console.log(`Dispatched code-review for #${pullRequestNumber} at ${eventHeadSha}.`);
}

async function runClose(): Promise<void> {
  const context = buildContext();
  const event = JSON.parse(readFileSync(requiredEnvironment("GITHUB_EVENT_PATH"), "utf8")) as {
    pull_request: { number: number };
  };
  const pullRequestNumber = event.pull_request.number;
  const runs = await listRecentRuns(context, new Date(), REVIEW_GATE_LIMITS);
  const queuedRunIds = selectSupersededRunIds(runs, { pullRequestNumber, headSha: "" });
  console.log(
    `#${pullRequestNumber} closed: ${queuedRunIds.length} queued automatic review(s) to cancel.`,
  );
  for (const runId of queuedRunIds) {
    try {
      await githubRequest(context, "POST", `/actions/runs/${runId}/cancel`);
      console.log(`Cancelled queued review run ${runId}.`);
    } catch (error) {
      console.log(`Could not cancel run ${runId}: ${(error as Error).message}`);
    }
  }
}

async function runGlobalCheck(): Promise<void> {
  const context = buildContext();
  const pullRequestNumber = Number(requiredEnvironment("PR_NUMBER"));
  const now = new Date();
  const runs = await listRecentRuns(context, now, REVIEW_GATE_LIMITS);
  const verdict = evaluateReviewLimits({
    runs,
    kind: "manual",
    pullRequestNumber,
    now,
    excludeRunId: Number(process.env["GITHUB_RUN_ID"]),
  });
  const outputPath = process.env["GITHUB_OUTPUT"];
  if (outputPath !== undefined) {
    appendFileSync(outputPath, `review_allowed=${verdict.allowed}\n`);
  }
  if (verdict.allowed) {
    console.log("Global cap not reached.");
    return;
  }
  console.log(`Manual review blocked: ${verdict.message}`);
  await upsertLimitComment(context, pullRequestNumber, verdict, "manual");
}

if (import.meta.main) {
  const mode = process.argv[2];
  const entries: Record<string, () => Promise<void>> = {
    gate: runGate,
    close: runClose,
    "global-check": runGlobalCheck,
  };
  const entry = (mode === undefined ? undefined : entries[mode]) ?? null;
  if (entry === null) {
    console.error("usage: jazz-review-gate.ts gate|close|global-check");
    process.exit(2);
  }
  entry().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
