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
import type {
  GoalBudget,
  GoalPlan,
  GoalRecordInput,
} from "../../../packages/core/src/agent/goal/goal-record";
import { MAIN_TS } from "../../run-jazz";
import { sandboxedArgv } from "../../sandbox";
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

/** What a scenario can do to a running goal from its `onPoll` hook. */
export interface GoalHarness {
  /** SIGKILL the daemon, as a crash would, and start a fresh one on the same home. */
  readonly crashAndRestart: () => Promise<void>;
  /** Pause or resume the goal through the daemon's control route, as `jazz goal` does. */
  readonly control: (operation: "pause" | "resume", note?: string) => Promise<boolean>;
  /** Record something the harness did, reported in the outcome for the check to read. */
  readonly note: (event: string) => void;
}

export interface GoalScenario {
  readonly request: string;
  /** Overrides on the eval's default budget, e.g. short cycles to force several of them. */
  readonly budget?: Partial<GoalBudget>;
  /** Start from a later point in the goal's life: a paused goal with earlier progress. */
  readonly initial?: Pick<GoalRecordInput, "state" | "lastProgress" | "usage">;
  /** The user's reply to any question the goal asks; a fixed deferral when absent. */
  readonly answer?: string;
  /** Called on every poll with the goal as the daemon reports it. */
  readonly onPoll?: (goal: GoalView, harness: GoalHarness) => Promise<void>;
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

export interface GoalView {
  readonly version: number;
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
    budget: {
      maxCycles: 6,
      maxTokens: 3_000_000,
      maxDurationMs: 20 * 60 * 1000,
      ...scenario.budget,
    },
    usage: { cycles: 0, totalTokens: 0, activeDurationMs: 0, costKnown: true, costUSD: 0 },
    ...scenario.initial,
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
  const startDaemon = () =>
    Bun.spawn(
      sandboxedArgv(
        [process.execPath, MAIN_TS, "daemon", "--foreground", "--port", String(port)],
        context.environment,
      ),
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
  let daemon = startDaemon();
  const events: string[] = [];

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

  const waitForDaemon = async (): Promise<GoalView> => {
    const upBy = Date.now() + DAEMON_STARTUP_MS;
    for (;;) {
      const view = await fetchGoal();
      if (view !== undefined) {
        return view;
      }
      if (Date.now() > upBy) {
        throw new Error("the goal daemon did not come up");
      }
      await Bun.sleep(POLL_INTERVAL_MS / 4);
    }
  };

  let last: GoalView | undefined;
  const harness: GoalHarness = {
    crashAndRestart: async () => {
      daemon.kill("SIGKILL");
      await daemon.exited;
      daemon = startDaemon();
      last = await waitForDaemon();
    },
    control: async (operation, note) => {
      const current = (await fetchGoal()) ?? last;
      const response = await fetch(`${base}/goals/${goalId}/${operation}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          version: current?.version,
          ...(note !== undefined ? { note } : {}),
        }),
      }).catch(() => undefined);
      return response?.ok === true;
    },
    note: (event) => {
      events.push(event);
    },
  };
  let timedOut = false;
  try {
    last = await waitForDaemon();
    const deadline = Date.now() + GOAL_DEADLINE_MS;
    for (;;) {
      last = (await fetchGoal()) ?? last;
      if (STOPPED_STATES.has(last.state.kind)) {
        break;
      }
      await scenario.onPoll?.(last, harness);
      if (Date.now() > deadline) {
        timedOut = true;
        break;
      }
      if (last.state.kind === "awaiting-input" && last.cycle !== undefined) {
        const body =
          last.state.reason === "question"
            ? { response: scenario.answer ?? QUESTION_ANSWER }
            : { approved: true };
        const answered = await fetch(`${base}/runs/${last.cycle.runId}/answer`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        }).catch(() => undefined);
        if (answered?.ok === true && last.state.reason === "question") {
          events.push("answered a question");
        }
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
    ...(events.length > 0 ? { harnessEvents: events } : {}),
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
