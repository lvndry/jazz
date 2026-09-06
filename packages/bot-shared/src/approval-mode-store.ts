/**
 * Per-conversation approval mode, shared by the Discord and Telegram bridges.
 *
 * Two user-facing modes sit on top of Jazz's three approval-policy tiers:
 * "safe" keeps whatever tier the deployment was configured with (so an
 * operator who set `read-only` still gets `read-only`), while "yolo" pins the
 * run to `high-risk`, which approves everything without prompting. Only "yolo"
 * is written to disk — an absent entry means safe, so the deployment default
 * keeps applying to every conversation that never opted out.
 *
 * `fileName` is the per-bridge store file (`dc-mode.json` / `tg-mode.json`).
 */

import {
  preserveCorruptFile,
  readRecordStore,
  recordStorePath,
  writeRecordStore,
} from "./scoped-record-store";

export type ApprovalMode = "safe" | "yolo";

export const APPROVAL_MODE_LABELS: Record<ApprovalMode, string> = {
  safe: "🛡️ Safe",
  yolo: "🎲 Yolo",
};

/**
 * How a bridge emphasises text. Discord speaks Markdown and Telegram speaks
 * HTML, so the wording below is shared while the markup stays per-platform —
 * what yolo promises is a product rule and must not drift between the two.
 */
export interface ApprovalModeMarkup {
  bold: (text: string) => string;
  code: (text: string) => string;
}

/**
 * One line describing what a mode does, for the picker and the confirmation.
 *
 * Safe names the tier the deployment actually configured, because "safe" is
 * that tier rather than a fixed one — an operator running `read-only` gets a
 * different promise from one running `low-risk`.
 */
export function describeApprovalMode(
  mode: ApprovalMode,
  configuredPolicy: string,
  markup: ApprovalModeMarkup,
): string {
  return mode === "yolo"
    ? `${markup.bold("🎲 Yolo")} — every tool runs without asking, including shell commands ` +
        "that write, delete, or reach the network. Nothing will stop and wait for you."
    : `${markup.bold("🛡️ Safe")} — anything above ${markup.code(configuredPolicy)} ` +
        "stops and asks you first.";
}

/** The tier a yolo conversation runs at: every tool auto-approved, nothing prompts. */
export const YOLO_APPROVAL_POLICY = "high-risk";

export function approvalModeFor(
  dataDir: string,
  fileName: string,
  scopeId: string | number,
): ApprovalMode {
  const stored = readRecordStore<ApprovalMode>(recordStorePath(dataDir, fileName))?.[
    String(scopeId)
  ];
  return stored === "yolo" ? "yolo" : "safe";
}

export function setApprovalMode(
  dataDir: string,
  fileName: string,
  scopeId: string | number,
  mode: ApprovalMode,
): void {
  const path = recordStorePath(dataDir, fileName);
  const current = readRecordStore<ApprovalMode>(path);
  if (current === null) {
    preserveCorruptFile(path);
  }
  const next = current ?? {};
  const key = String(scopeId);
  if (mode === "yolo") {
    next[key] = "yolo";
  } else {
    delete next[key];
  }
  writeRecordStore(path, next);
}

/**
 * Resolve the `--approval-policy` value for a conversation, given the tier the
 * deployment was configured with.
 */
export function approvalPolicyFor(
  dataDir: string,
  fileName: string,
  scopeId: string | number,
  configuredPolicy: string,
): string {
  return approvalModeFor(dataDir, fileName, scopeId) === "yolo"
    ? YOLO_APPROVAL_POLICY
    : configuredPolicy;
}
