/**
 * @fileoverview Reading the `--approval-policy` a command grants a goal or loop.
 */

import {
  APPROVAL_POLICY_LEVELS,
  isApprovalPolicyLevel,
  type ApprovalPolicyLevel,
} from "@jazz/core/types/tools";

/**
 * The approval policy a command grants, or a refusal for an unknown tier: a typo must not leave
 * unattended work with a tier nobody asked for.
 */
export function grantedPolicy(
  value: string | undefined,
):
  | { readonly kind: "granted"; readonly policy?: ApprovalPolicyLevel }
  | { readonly kind: "invalid"; readonly reason: string } {
  if (value === undefined) {
    return { kind: "granted" };
  }
  return isApprovalPolicyLevel(value)
    ? { kind: "granted", policy: value }
    : {
        kind: "invalid",
        reason: `Invalid --approval-policy "${value}". Expected ${APPROVAL_POLICY_LEVELS.join(", ")}.`,
      };
}
