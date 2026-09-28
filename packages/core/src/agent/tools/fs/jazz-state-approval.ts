import { jazzStateApprovalNotice, jazzStateChangeReason } from "@/core/utils/jazz-state-paths";

/**
 * The approval message for a file tool changing `targets`: as it is, or, when one of them is
 * Jazz's own configuration or state, with that said and put to a person under every policy.
 */
export function jazzStateApproval(
  message: string,
  targets: readonly string[],
): string | { message: string; alwaysAsk: true } {
  const reasons = targets.flatMap((target) => {
    const reason = jazzStateChangeReason(target);
    return reason === undefined ? [] : [jazzStateApprovalNotice(reason)];
  });
  if (reasons.length === 0) {
    return message;
  }
  return { message: [message, ...reasons].join("\n\n"), alwaysAsk: true };
}
