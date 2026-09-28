/**
 * The facts and words of a question the agent asks, shared by the fullscreen overlay and the
 * Ink questionnaire so both say the same thing and answer to the same keys.
 */

/** The last row of every question: an answer in the person's own words. */
export const CUSTOM_ANSWER_LABEL = "Something else…";

/** Number keys pick the first nine rows; a tenth row would need two keystrokes. */
export const MAX_QUICK_PICK = 9;

const YES_LABEL = /^yes\b/i;
const NO_LABEL = /^no\b/i;

/**
 * The two answers of a yes/no question, by index, so it can be drawn as two buttons and
 * answered with y or n: exactly two choices, one a Yes and one a No, answered singly.
 */
export function binaryAnswerIndices(
  labels: readonly string[],
  allowMultiple: boolean,
): { readonly yes: number; readonly no: number } | undefined {
  if (allowMultiple || labels.length !== 2) return undefined;
  const yes = labels.findIndex((label) => YES_LABEL.test(label.trim()));
  const no = labels.findIndex((label) => NO_LABEL.test(label.trim()));
  return yes >= 0 && no >= 0 && yes !== no ? { yes, no } : undefined;
}

export interface QuestionKey {
  readonly key: string;
  readonly label: string;
}

/** The keys a question answers to, in the order both renderers list them. */
export function questionKeys(options: {
  readonly binary: boolean;
  readonly multiple: boolean;
  readonly choiceCount: number;
  readonly skippable: boolean;
}): readonly QuestionKey[] {
  const escape = { key: "esc", label: options.skippable ? "skip question" : "cancel" };
  const pick = `1-${String(Math.min(options.choiceCount, MAX_QUICK_PICK))}`;
  if (options.binary) {
    return [
      { key: "left/right", label: "choose" },
      { key: "enter", label: "confirm" },
      { key: "y/n", label: "answer" },
      escape,
    ];
  }
  if (options.multiple) {
    return [
      { key: "up/down", label: "move" },
      { key: "space", label: "toggle" },
      { key: pick, label: "toggle" },
      { key: "enter", label: "submit" },
      escape,
    ];
  }
  return [
    { key: "up/down", label: "choose" },
    { key: "enter", label: "confirm" },
    { key: pick, label: "pick" },
    escape,
  ];
}

/** `1 of 2`, only when the question is one of several asked together. */
export function questionPositionLabel(
  position: { readonly index: number; readonly total: number } | undefined,
): string | undefined {
  return position !== undefined && position.total > 1
    ? `${String(position.index)} of ${String(position.total)}`
    : undefined;
}
