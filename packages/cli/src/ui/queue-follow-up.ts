import { store } from "./store";

export type FollowUpOutcome = "queued" | "ran-command" | "empty";

/**
 * Tab while a run is active: queue the draft to run as its own turn after the current one ends,
 * leaving the running turn undisturbed. A command that answers right away still runs at once.
 */
export function queueFollowUp(draft: string): FollowUpOutcome {
  if (draft.trim().length === 0) {
    return "empty";
  }
  if (store.runCommandImmediately(draft)) {
    return "ran-command";
  }
  store.appendToQueue(draft, "followup");
  return "queued";
}
