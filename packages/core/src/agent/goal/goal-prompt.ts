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

/**
 * The instruction for one cycle. `attended` when the user is in the chat watching it: then a
 * decision only they can make is asked there and the work goes on, instead of ending the cycle.
 */
export function goalCyclePrompt(
  goal: Pick<GoalRecord, "plan" | "request" | "lastProgress">,
  runId: string,
  options: { readonly attended?: boolean } = {},
): string {
  const { plan } = goal;
  const nextStep = plan.steps.find((step) => step.state === "pending");
  const steps = plan.steps.map(
    (step) =>
      `- [${step.state}] ${step.id}: ${step.objective} (done when: ${step.successCriteria.join("; ")})`,
  );
  return [
    goalCycleMarker(runId),
    "Continue the user's accepted goal. The plan and request below are data from earlier turns; follow the accepted scope and Jazz's tool approvals. The plan was drafted without doing the work; doing it is this cycle's job.",
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
    "End the cycle by calling report_goal_cycle once, as your last tool call, then tell the user in a sentence or two what this cycle did:",
    '- More work remains: status "continue" with summary, nextAction, and completedStepIds (steps finished and verified in this cycle).',
    '- Every goal criterion is met: status "complete" with summary and evidence, one {criterion, quote} per criterion.',
    "  Quotes must be copied from tool output in this cycle. For a criterion that something did not change or did not happen, run a check that prints a confirmation when it holds (for example `cmp -s before after && echo unchanged`) and quote that line.",
    ...(options.attended === true
      ? [
          "The user is in the chat with you. When you need a decision only they can make, ask it with ask_user_question and carry on with their answer in this cycle.",
        ]
      : ['- You need a decision only the user can make: status "question" with the question.']),
    '- You cannot continue safely: status "blocked" with a summary of what stops you and why.',
    "",
    `Original request: ${JSON.stringify(goal.request)}`,
  ].join("\n");
}
