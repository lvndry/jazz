/**
 * The two approval modes interactive chat offers, as policies.
 *
 * Safe mode is the `low-risk` tier: someone is at the keyboard, so the command classifier
 * runs, read-only and low-risk tools and commands proceed, and anything high-risk asks.
 * Yolo is `true`, which approves everything. Chat starts in safe mode, and `/mode safe`,
 * Shift+Tab and the fullscreen toggle all return to it. A run with no policy at all (an
 * unattended one nobody granted a tier) is stricter than either: nothing clears.
 */
import type { AutoApprovePolicy } from "@jazz/core/types/tools";

export type ChatApprovalMode = "safe" | "yolo";

export const SAFE_MODE_POLICY = "low-risk" as const satisfies AutoApprovePolicy;
export const YOLO_MODE_POLICY = true as const satisfies AutoApprovePolicy;

export function policyForChatMode(mode: ChatApprovalMode): AutoApprovePolicy {
  return mode === "yolo" ? YOLO_MODE_POLICY : SAFE_MODE_POLICY;
}

export function chatModeForPolicy(policy: AutoApprovePolicy | undefined): ChatApprovalMode {
  return policy === true || policy === "high-risk" ? "yolo" : "safe";
}
