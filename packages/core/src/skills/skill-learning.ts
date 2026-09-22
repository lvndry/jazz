/**
 * Proposal-only skill learning from recurring misfires.
 *
 * This module never writes a skill. A later explicitly confirmed mutation must
 * consume the bounded proposal and validate its target and content. The
 * failure text that reaches the proposal is the derived error class, never the
 * raw message, so a proposal can be shown or stored without leaking what the
 * tool was operating on.
 */
import type { MisfireEntry } from "@/core/agent/tools/misfire-log";
import { misfireErrorClass } from "@/core/agent/tools/misfire-report";

export interface SkillLearningProposal {
  readonly name: string;
  readonly description: string;
  readonly content: string;
  readonly target: "global" | "project";
  readonly evidenceCount: number;
  readonly failureClass: string;
}

/** Fewest misfires of one class before a proposal is worth a person's time. */
export const MIN_MISFIRE_RECURRENCE = 2;

function safeName(toolName: string): string {
  return `${toolName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-recovery`.slice(0, 48);
}

/**
 * Creates a bounded proposal when the same tool fails the same way at least
 * `MIN_MISFIRE_RECURRENCE` times. Recurrence is judged on the error class, so
 * two unrelated failures of one tool do not count as a pattern.
 */
export function proposeSkillFromMisfires(
  entries: readonly MisfireEntry[],
  target: "global" | "project" = "project",
): SkillLearningProposal | undefined {
  const first = entries[0];
  if (first === undefined) return undefined;
  const failureClass = misfireErrorClass(first.errorMessage);
  const recurring = entries.filter(
    (entry) =>
      entry.toolName === first.toolName && misfireErrorClass(entry.errorMessage) === failureClass,
  );
  if (recurring.length < MIN_MISFIRE_RECURRENCE) return undefined;
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
    evidenceCount: recurring.length,
    failureClass,
  };
}
