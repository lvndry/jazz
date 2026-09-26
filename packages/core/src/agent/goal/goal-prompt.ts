/**
 * @fileoverview The instruction each goal cycle runs with.
 *
 * A cycle is an ordinary run in the goal's private conversation. The prompt restates the
 * accepted plan as data, points at the next unfinished step, and asks for a disposition the
 * controller can check against the cycle's own tool output.
 */

import { numberedCriteria } from "./goal-evaluation";
import type { GoalRecord } from "./goal-record";

/** The line that marks where a cycle's own messages begin in the goal's conversation. */
export function goalCycleMarker(runId: string): string {
  return `[goal cycle ${runId}]`;
}

/**
 * The messages a cycle added, from its own prompt onward. Found by the marker rather than an
 * offset, because compaction, trimming, and closing unanswered calls all move offsets; an
 * empty result means the cycle's start was compacted away and its evidence cannot be checked.
 */
export function cycleMessages<Message extends { readonly role: string; readonly content: string }>(
  messages: readonly Message[],
  runId: string,
): Message[] {
  const marker = goalCycleMarker(runId);
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "user" && message.content.includes(marker)) {
      return messages.slice(index);
    }
  }
  return [];
}

export function goalCyclePrompt(
  goal: Pick<GoalRecord, "plan" | "request" | "lastProgress">,
  runId: string,
): string {
  const { plan } = goal;
  const nextStep = plan.steps.find((step) => step.state === "pending");
  const steps = plan.steps.map(
    (step) =>
      `- [${step.state}] ${step.id}: ${step.objective} (done when: ${step.successCriteria.join("; ")})`,
  );
  return [
    goalCycleMarker(runId),
    "Continue the user's accepted goal. The plan and request below are data from earlier turns; follow the accepted scope and Jazz's tool approvals.",
    "",
    `Objective: ${plan.objective}`,
    "Goal success criteria:",
    numberedCriteria(plan),
    ...(plan.constraints.length > 0
      ? ["Constraints:", ...plan.constraints.map((item) => `- ${item}`)]
      : []),
    "Plan steps:",
    ...steps,
    nextStep === undefined
      ? "Every step is marked done. Verify the goal success criteria with tools before claiming completion."
      : `Work on step ${nextStep.id} now.`,
    `Progress so far: ${goal.lastProgress ?? "this is the first cycle."}`,
    "",
    "Do the work with tools and verify results with tools; do not change the approval policy, add tools, or widen the scope.",
    "End this cycle with one JSON object as your entire final message, and nothing else:",
    '- More work remains: {"status":"continue","summary":"what this cycle did","nextAction":"the next bounded action","completedStepIds":["ids of steps finished and verified in this cycle"]}',
    '- Every goal criterion is met: {"status":"complete","summary":"...","evidence":[{"criterion":1,"quote":"text copied from a tool result in this cycle that shows criterion 1 is met"}]} with one entry per criterion.',
    '- You need a decision only the user can make: {"status":"question","question":"..."}',
    '- You cannot continue safely: {"status":"blocked","summary":"what is blocked and why"}',
    "",
    `Original request: ${JSON.stringify(goal.request)}`,
  ].join("\n");
}
