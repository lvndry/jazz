/**
 * Pane-state adapter contract.
 *
 * Tiling workspaces that embed agents — Herdr, TUIOS, tmux-style panes —
 * want to show which agent runs in a pane and whether it is working,
 * blocked on the user, or idle. Each such product ships its own small
 * protocol (env vars, CLI, socket); this interface is the Jazz side of it.
 *
 * An adapter is inert unless its product is present (`isActive()`), is
 * driven by `onSnapshot()` as the chat session changes, and `release()`s
 * its pane on exit. Adapters are fail-open: a missing or slow pane
 * product must never delay or break the chat.
 *
 * Adding support for a new product is one new file implementing
 * `PaneStateAdapter` plus one entry in `pane-state-registry.ts`; the chat
 * service does not change.
 */

import type { ActivityState } from "@/cli/ui/activity-state";

/**
 * The slice of the session snapshot pane adapters read. The store's
 * `SessionSnapshot` structurally satisfies this; keeping the source loose
 * means adapters never import the store.
 */
export interface PaneStateSnapshot {
  readonly activity: ActivityState;
  readonly approvalRequest: {
    readonly toolName: string;
    readonly args: Readonly<Record<string, unknown>>;
  } | null;
  readonly activeMenu: unknown;
  readonly currentConversation: {
    readonly agentId: string;
    readonly conversationId: string;
  } | null;
}

/** The three states every pane product understands. */
export type PaneAgentState = "idle" | "working" | "blocked";

/** Why an agent is blocked, when it is worth saying so. */
export interface PaneBlockedReason {
  readonly kind: "approval" | "question" | "other";
  readonly label: string;
}

export interface PaneStateAdapter {
  /** True when the pane product this adapter reports to is present. */
  readonly isActive: boolean;
  /** The short identity of the pane product, e.g. "herdr". */
  readonly name: string;
  onSnapshot(snapshot: PaneStateSnapshot): void;
  /** Release the pane's agent slot; idempotent. */
  release(): void;
}

/**
 * Maps what the UI is doing to the three pane states: a pending approval
 * or an active menu means the agent needs the user (blocked), any
 * in-flight turn phase means it is working, and everything else — ready
 * prompt, completed turn, turn error — means idle.
 */
export function derivePaneState(snapshot: PaneStateSnapshot): PaneAgentState {
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
 * Human-readable label for a blocked report, taken from whatever is asking
 * for the user: an approval (labeled by tool and command) or an active
 * menu (a question, choice, or secret prompt). Undefined when there is
 * nothing to explain — the blocked state itself already says so.
 */
export function paneBlockedReason(snapshot: PaneStateSnapshot): PaneBlockedReason | undefined {
  const approval = snapshot.approvalRequest;
  if (approval !== null && approval !== undefined) {
    const command =
      typeof approval.args["command"] === "string" && approval.args["command"].length > 0
        ? ` ${approval.args["command"]}`
        : "";
    return { kind: "approval", label: `Approval needed: ${approval.toolName}${command}` };
  }
  if (snapshot.activeMenu !== null && snapshot.activeMenu !== undefined) {
    return { kind: "question", label: "Waiting on your input" };
  }
  return undefined;
}

/** Releases every active adapter on any process exit, including signals. */
let exitHooksInstalled = false;

export function installPaneStateExitHooks(releaseAll: () => void): void {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;
  process.once("exit", releaseAll);
  process.once("SIGINT", () => {
    releaseAll();
    process.kill(process.pid, "SIGINT");
  });
  process.once("SIGTERM", () => {
    releaseAll();
    process.kill(process.pid, "SIGTERM");
  });
}
