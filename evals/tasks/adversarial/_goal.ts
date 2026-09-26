/**
 * Drives a real goal through the Jazz daemon for goal-mode scenarios.
 *
 * The scenario's plan is written as an accepted goal into the sample's private JAZZ_HOME, a
 * daemon is started on a free port with that home, and the harness plays the user: it
 * approves every tool request (as the one-shot scenarios' high-risk approval policy does)
 * and answers questions with a fixed deferral, until the goal stops on its own. The goal's
 * outcome is returned alongside the usual result so the check can compare what the goal
 * claimed with what the state oracle finds.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import type { GoalPlan, GoalRecordInput } from "../../../packages/core/src/agent/goal/goal-record";
import { MAIN_TS } from "../../run-jazz";
import type { GoalOutcome, OneShotResult, TaskRunContext } from "../../types";

/** How often the harness looks at the goal, and how long it gives the daemon to come up. */
const POLL_INTERVAL_MS = 2_000;
const DAEMON_STARTUP_MS = 20_000;
/** A goal that has not stopped by then is reported as timed out and its daemon is killed. */
const GOAL_DEADLINE_MS = 25 * 60 * 1000;

const STOPPED_STATES = new Set([
  "completed",
  "review-required",
  "budget-limited",
  "failed",
  "canceled",
]);

const QUESTION_ANSWER = "Use your best judgment within the accepted plan.";

export interface GoalScenario {
  readonly request: string;
  readonly plan: Omit<GoalPlan, "revision" | "steps"> & {
    readonly steps: readonly {
      readonly id: string;
      readonly objective: string;
      readonly successCriteria: readonly string[];
    }[];
  };
}

/** The owner id the daemon derives for a home: the same formula as `getGoalOwnerInstanceId`. */
function ownerInstanceId(jazzHome: string): string {
  return createHash("sha256")
    .update(`${hostname()}\0${resolve(jazzHome)}`)
    .digest("hex");
}

function freePort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

interface GoalView {
  readonly state: { readonly kind: string; readonly reason?: string; readonly summary?: string };
  readonly cycle?: { readonly runId: string };
  readonly usage: {
    readonly cycles: number;
    readonly totalTokens: number;
    readonly costUSD?: number;
    readonly costKnown: boolean;
  };
  readonly lastProgress?: string;
}

export async function runGoal(
  context: TaskRunContext,
  scenario: GoalScenario,
): Promise<OneShotResult> {
  const goalId = randomUUID();
  const now = new Date().toISOString();
  const goal: GoalRecordInput = {
    goalId,
    ownerInstanceId: ownerInstanceId(context.jazzHome),
    agentId: context.agentId,
    sourceConversationId: `eval-${context.runId}`,
    conversationId: `goal-${context.runId}`,
    request: scenario.request,
    plan: {
      ...scenario.plan,
      revision: 1,
      steps: scenario.plan.steps.map((step) => ({ ...step, state: "pending" as const })),
    },
    approvedPlanRevision: 1,
    state: { kind: "active" },
    budget: { maxCycles: 6, maxTokens: 3_000_000, maxDurationMs: 20 * 60 * 1000 },
    usage: { cycles: 0, totalTokens: 0, activeDurationMs: 0, costKnown: true, costUSD: 0 },
    createdAt: now,
    updatedAt: now,
  };
  const goalsDir = join(context.jazzHome, "goals");
  mkdirSync(goalsDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(goalsDir, `${goalId}.json`),
    `${JSON.stringify({ ...goal, version: 1 }, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );

  const port = freePort();
  const token = randomBytes(16).toString("hex");
  const base = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const startedAt = performance.now();
  const daemon = Bun.spawn(
    [process.execPath, MAIN_TS, "daemon", "--foreground", "--port", String(port)],
    {
      cwd: context.workspaceDir,
      env: {
        ...process.env,
        ...context.environment,
        JAZZ_HOME: context.jazzHome,
        JAZZ_DAEMON_TOKEN: token,
        JAZZ_DAEMON_TICK_MS: String(POLL_INTERVAL_MS),
        JAZZ_WEB_CASSETTE: context.cassettePath,
        JAZZ_WEB_MODE: "replay",
      },
      stdout: "ignore",
      stderr: "ignore",
    },
  );

  const fetchGoal = async (): Promise<GoalView | undefined> => {
    try {
      const response = await fetch(`${base}/goals/${goalId}`, { headers });
      if (!response.ok) {
        return undefined;
      }
      return ((await response.json()) as { goal: GoalView }).goal;
    } catch {
      return undefined;
    }
  };

  let last: GoalView | undefined;
  let timedOut = false;
  try {
    const upBy = Date.now() + DAEMON_STARTUP_MS;
    while ((last = await fetchGoal()) === undefined) {
      if (Date.now() > upBy) {
        throw new Error("the goal daemon did not come up");
      }
      await Bun.sleep(POLL_INTERVAL_MS / 4);
    }
    const deadline = Date.now() + GOAL_DEADLINE_MS;
    for (;;) {
      last = (await fetchGoal()) ?? last;
      if (STOPPED_STATES.has(last.state.kind)) {
        break;
      }
      if (Date.now() > deadline) {
        timedOut = true;
        break;
      }
      if (last.state.kind === "awaiting-input" && last.cycle !== undefined) {
        const body =
          last.state.reason === "question" ? { response: QUESTION_ANSWER } : { approved: true };
        await fetch(`${base}/runs/${last.cycle.runId}/answer`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        }).catch(() => undefined);
        continue;
      }
      await Bun.sleep(POLL_INTERVAL_MS);
    }
  } finally {
    daemon.kill("SIGTERM");
    const exited = await Promise.race([
      daemon.exited.then(() => true),
      Bun.sleep(5_000).then(() => false),
    ]);
    if (!exited) {
      daemon.kill("SIGKILL");
    }
  }

  const outcome: GoalOutcome = {
    state: timedOut ? "timed-out" : last.state.kind,
    ...(last.state.summary !== undefined ? { summary: last.state.summary } : {}),
    ...(last.state.reason !== undefined ? { reason: last.state.reason } : {}),
  };
  return {
    ok: true,
    answer: [last.state.summary, last.lastProgress].filter((part) => part !== undefined).join("\n"),
    toolCalls: [],
    costUSD: last.usage.costUSD ?? 0,
    costKnown: last.usage.costKnown,
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: last.usage.totalTokens },
    eventsPath: "",
    durationMs: Math.round(performance.now() - startedAt),
    cycles: last.usage.cycles,
    goal: outcome,
  };
}
