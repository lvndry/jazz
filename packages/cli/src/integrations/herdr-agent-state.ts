/**
 * Herdr agent-state reporter.
 *
 * When Jazz runs inside a Herdr pane, the pane's environment carries
 * `HERDR_ENV=1`, `HERDR_PANE_ID`, and `HERDR_BIN_PATH`. This module turns
 * Jazz's chat-session lifecycle into state reports for that pane, so the
 * Herdr sidebar and `herdr agent list` show the agent's name and `working`,
 * `blocked`, or `idle` state, and Herdr can restore the session after a
 * server restart by re-running the reported resume command.
 *
 * The integration is fail-open by design: reports run in the background with
 * a short timeout, every failure is ignored, and outside a Herdr pane the
 * reporter is an inert no-op, so a missing or slow Herdr can never delay or
 * break a chat session.
 *
 * Docs: https://herdr.dev/docs/add-herdr-support/
 */

import { spawn, type SpawnOptions } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { getJazzHomeDirectory } from "@jazz/core/utils/paths";
import type { ActivityState } from "@/cli/ui/activity-state";

export type HerdrAgentState = "idle" | "working" | "blocked";

export interface HerdrBlockedReason {
  readonly kind: "approval" | "question" | "other";
  readonly label: string;
}

export interface HerdrSession {
  readonly agent: string;
  readonly conversationId: string;
}

export interface HerdrReporter {
  readonly enabled: boolean;
  reportState(state: HerdrAgentState, reason?: HerdrBlockedReason): void;
  reportSession(session: HerdrSession): void;
  release(): void;
}

/**
 * The resume command Herdr re-runs to reopen this conversation after a
 * server restart. First word is a plain name on PATH, no apostrophes or
 * control characters in any argument.
 */
export function resumeCommandFor(session: HerdrSession): readonly string[] {
  return [
    "jazz",
    "agent",
    "chat",
    session.agent,
    "--continue",
    "--conversation",
    session.conversationId,
  ];
}

/**
 * Derives Herdr's three states from what the UI is currently doing:
 * a pending approval or an active menu means the agent needs the user
 * (blocked), any in-flight turn phase means it is working, and everything
 * else — ready prompt, completed turn, turn error — means idle.
 */
export function deriveHerdrState(snapshot: {
  readonly activity: ActivityState;
  readonly approvalRequest: unknown;
  readonly activeMenu: unknown;
}): HerdrAgentState {
  if (snapshot.approvalRequest !== null && snapshot.approvalRequest !== undefined) {
    return "blocked";
  }
  if (snapshot.activeMenu !== null && snapshot.activeMenu !== undefined) {
    return "blocked";
  }
  switch (snapshot.activity.phase) {
    case "awaiting":
    case "thinking":
    case "streaming":
    case "tool-execution":
      return "working";
    case "idle":
    case "complete":
    case "error":
      return "idle";
  }
}

/**
 * Human-readable `--message` for a blocked report, taken from whatever is
 * asking for the user: an approval (labeled by the tool and command) or an
 * active menu (a question, choice, or secret prompt). Undefined when there
 * is nothing to explain, which is fine — the blocked state itself already
 * says the agent needs input.
 */
export function herdrBlockedReason(snapshot: {
  readonly activity: ActivityState;
  readonly approvalRequest: unknown;
  readonly activeMenu: unknown;
}): HerdrBlockedReason | undefined {
  if (snapshot.approvalRequest !== null && snapshot.approvalRequest !== undefined) {
    const approval = snapshot.approvalRequest as { toolName?: unknown; command?: unknown };
    const tool = typeof approval.toolName === "string" ? approval.toolName : "tool";
    const command =
      typeof approval.command === "string" && approval.command.length > 0
        ? ` ${approval.command}`
        : "";
    return { kind: "approval", label: `Approval needed: ${tool}${command}` };
  }
  if (snapshot.activeMenu !== null && snapshot.activeMenu !== undefined) {
    return { kind: "question", label: "Waiting on your input" };
  }
  return undefined;
}

const REPORT_SOURCE = "jazz";
const REPORT_TIMEOUT_MS = 3000;

interface HerdrEnv {
  readonly paneId: string;
  readonly binPath: string;
}

function readHerdrEnv(env: NodeJS.ProcessEnv = process.env): HerdrEnv | undefined {
  if (env["HERDR_ENV"] !== "1") return undefined;
  const paneId = env["HERDR_PANE_ID"];
  const binPath = env["HERDR_BIN_PATH"];
  if (paneId === undefined || paneId.length === 0) return undefined;
  if (binPath === undefined || binPath.length === 0) return undefined;
  return { paneId, binPath };
}

function seqFileFor(env: HerdrEnv): string {
  return path.join(getJazzHomeDirectory(), "herdr", `seq-${env.paneId}`);
}

function loadLastSeq(env: HerdrEnv): number {
  try {
    const raw = fs.readFileSync(seqFileFor(env), "utf8");
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

function persistSeq(env: HerdrEnv, seq: number): void {
  try {
    const dir = path.dirname(seqFileFor(env));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(seqFileFor(env), String(seq));
  } catch {
    // Seq persistence is best-effort: without it, reports from a fresh
    // process may be older than ones Herdr already accepted. Dropping them
    // is the documented safe outcome, so a missing file is fine.
  }
}

/**
 * Fire-and-forget spawn of the Herdr CLI. Never throws, never blocks the
 * caller, never inherits stdio into the pane: a Herdr failure is noise at
 * worst.
 */
function runHerdr(binPath: string, args: readonly string[]): void {
  let child;
  try {
    child = spawn(binPath, [...args], {
      stdio: "ignore",
      env: { ...process.env },
    } as SpawnOptions);
  } catch {
    return;
  }
  child.on("error", () => {});
  const killTimer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }, REPORT_TIMEOUT_MS);
  killTimer.unref?.();
  child.on("close", () => clearTimeout(killTimer));
  child.on("error", () => clearTimeout(killTimer));
}

class HerdrReporterImpl implements HerdrReporter {
  readonly enabled = true;
  private lastSeq: number;
  private currentSession: HerdrSession | undefined;
  private released = false;

  constructor(private readonly env: HerdrEnv) {
    this.lastSeq = loadLastSeq(env);
  }

  reportState(state: HerdrAgentState, reason?: HerdrBlockedReason): void {
    if (this.released) return;
    const args = [
      "pane",
      "report-agent",
      this.env.paneId,
      "--source",
      REPORT_SOURCE,
      "--agent",
      this.currentSession?.agent ?? "jazz",
      "--state",
      state,
      "--seq",
      String(this.nextSeq()),
    ];
    if (state === "blocked" && reason !== undefined) {
      args.push("--message", reason.label);
    }
    if (this.currentSession !== undefined && this.currentSession.conversationId.length > 0) {
      args.push(
        "--agent-session-id",
        this.currentSession.conversationId,
        "--",
        ...resumeCommandFor(this.currentSession),
      );
    }
    runHerdr(this.env.binPath, args);
  }

  reportSession(session: HerdrSession): void {
    this.currentSession = session;
    this.reportState("idle");
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    runHerdr(this.env.binPath, [
      "pane",
      "release-agent",
      this.env.paneId,
      "--source",
      REPORT_SOURCE,
      "--agent",
      this.currentSession?.agent ?? "jazz",
      "--seq",
      String(this.nextSeq()),
    ]);
  }

  private nextSeq(): number {
    this.lastSeq += 1;
    persistSeq(this.env, this.lastSeq);
    return this.lastSeq;
  }
}

const NOOP: HerdrReporter = {
  enabled: false,
  reportState: () => {},
  reportSession: () => {},
  release: () => {},
};

/**
 * The reporter for this process, or a no-op outside Herdr. Constructed once;
 * the chat service drives it and process-level handlers call `release()`
 * before the process goes away.
 */
let reporter: HerdrReporter | undefined;

export function herdrReporter(): HerdrReporter {
  if (reporter === undefined) {
    const env = readHerdrEnv();
    reporter = env === undefined ? NOOP : new HerdrReporterImpl(env);
  }
  return reporter;
}

/** Test seam: replaces the module-level reporter for the duration of a test. */
export function setHerdrReporterForTests(next: HerdrReporter): void {
  reporter = next;
}

/** Releases the pane on any process exit, including crashes and signals. */
let exitHooksInstalled = false;

export function installHerdrExitHooks(): void {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;
  const release = () => herdrReporter().release();
  process.once("exit", release);
  process.once("SIGINT", () => {
    release();
    process.kill(process.pid, "SIGINT");
  });
  process.once("SIGTERM", () => {
    release();
    process.kill(process.pid, "SIGTERM");
  });
}
