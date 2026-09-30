/**
 * Herdr pane-state adapter.
 *
 * When Jazz runs inside a Herdr pane, the pane's environment carries
 * `HERDR_ENV=1`, `HERDR_PANE_ID`, and `HERDR_BIN_PATH`. This adapter turns
 * Jazz's chat-session state into reports for that pane, so the Herdr
 * sidebar and `herdr agent list` show the agent's name and `working`,
 * `blocked`, or `idle` state, and Herdr can restore the session after a
 * server restart by re-running the reported resume command.
 *
 * The integration is fail-open by design: reports run in the background
 * with a short timeout, every failure is ignored, and outside a Herdr pane
 * the adapter is inert, so a missing or slow Herdr can never delay or
 * break a chat.
 *
 * Docs: https://herdr.dev/docs/add-herdr-support/
 */

import { spawn, type SpawnOptions } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { getJazzHomeDirectory } from "@jazz/core/utils/paths";
import {
  derivePaneState,
  paneBlockedReason,
  type PaneAgentState,
  type PaneBlockedReason,
  type PaneStateAdapter,
  type PaneStateSnapshot,
} from "@/cli/integrations/pane-state";

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

const REPORT_SOURCE = "jazz";
const REPORT_TIMEOUT_MS = 3000;

/**
 * The resume command Herdr re-runs to reopen this conversation after a
 * server restart. First word is a plain name on PATH, no apostrophes or
 * control characters in any argument.
 */
export function herdrResumeCommand(agent: string, conversationId: string): readonly string[] {
  return ["jazz", "agent", "chat", agent, "--continue", "--conversation", conversationId];
}

class HerdrPaneAdapter implements PaneStateAdapter {
  readonly isActive = true;
  readonly name = "herdr";

  private lastSeq: number;
  private currentAgent: string | undefined;
  private currentConversationId: string | undefined;
  private released = false;

  constructor(private readonly env: HerdrEnv) {
    this.lastSeq = loadLastSeq(env);
  }

  onSnapshot(snapshot: PaneStateSnapshot): void {
    if (this.released) return;
    const conversation = snapshot.currentConversation;
    if (conversation !== null) {
      this.currentAgent = conversation.agentId;
      this.currentConversationId = conversation.conversationId;
    }
    const state = derivePaneState(snapshot);
    const reason = state === "blocked" ? paneBlockedReason(snapshot) : undefined;
    const args = [
      "pane",
      "report-agent",
      this.env.paneId,
      "--source",
      REPORT_SOURCE,
      "--agent",
      this.currentAgent ?? "jazz",
      "--state",
      state,
      "--seq",
      String(this.nextSeq()),
    ];
    if (reason !== undefined) {
      args.push("--message", reason.label);
    }
    if (this.currentConversationId !== undefined && this.currentConversationId.length > 0) {
      args.push(
        "--agent-session-id",
        this.currentConversationId,
        "--",
        ...herdrResumeCommand(this.currentAgent ?? "jazz", this.currentConversationId),
      );
    }
    runHerdr(this.env.binPath, args);
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
      this.currentAgent ?? "jazz",
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

/**
 * The Herdr adapter for this process, active only inside a Herdr pane.
 * Constructed once; the pane-state registry drives it.
 */
export function herdrPaneAdapter(): PaneStateAdapter {
  const env = readHerdrEnv();
  if (env === undefined) return createInactivePaneAdapter("herdr");
  return new HerdrPaneAdapter(env);
}

function createInactivePaneAdapter(name: string): PaneStateAdapter {
  return { isActive: false, name, onSnapshot: () => {}, release: () => {} };
}

export type { PaneAgentState, PaneBlockedReason };
