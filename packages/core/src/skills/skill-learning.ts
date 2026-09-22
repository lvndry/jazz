/**
 * Proposal-only skill learning from recurring sanitized misfires.
 *
 * This module never writes a skill. A later explicitly confirmed mutation must
 * consume the bounded proposal and validate its target and content.
 */
import type { MisfireEntry } from "@/core/agent/tools/misfire-log";

export interface SkillLearningProposal {
  readonly name: string;
  readonly description: string;
  readonly content: string;
  readonly target: "global" | "project";
  readonly evidenceCount: number;
  readonly failureClass: string;
}

function safeName(toolName: string): string {
  return `${toolName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-recovery`.slice(0, 48);
}

/** Create a bounded proposal only when the same tool failure recurs. */
export function proposeSkillFromMisfires(
  entries: readonly MisfireEntry[],
  target: "global" | "project" = "project",
): SkillLearningProposal | undefined {
  if (entries.length < 2) return undefined;
  const first = entries[0];
  if (first === undefined || entries.some((entry) => entry.toolName !== first.toolName))
    return undefined;
  const failureClass = first.errorMessage.replace(/\s+/g, " ").slice(0, 160);
  const name = safeName(first.toolName);
  return {
    name,
    description: `Recover from recurring ${first.toolName} failures safely`,
    content: [
      `# ${name}`,
      "",
      "## When to use",
      `Use this when ${first.toolName} reports: ${failureClass}`,
      "",
      "## Procedure",
      "1. Inspect the relevant input and error context.",
      "2. Make the smallest safe correction.",
      "3. Verify the operation before continuing.",
      "",
      "## Verification",
      "Confirm the original operation succeeds and do not retry blindly.",
    ].join("\n"),
    target,
    evidenceCount: entries.length,
    failureClass,
  };
}
