export type EditAgentStepOutcome = "updated" | "cancelled" | "done";

const DONE_FIELD = "done";

export function isEditAgentMenuExit(
  fieldToUpdate: string | undefined,
): fieldToUpdate is undefined | "" | "done" {
  return fieldToUpdate === undefined || fieldToUpdate === "" || fieldToUpdate === DONE_FIELD;
}

export function shouldReturnToEditAgentMenu(outcome: EditAgentStepOutcome): boolean {
  return outcome !== "done";
}
