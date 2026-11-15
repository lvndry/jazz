import { concealValue } from "@jazz/core/presentation/concealed-line";

export { concealValue };

export const SECRET_MASK_CHARACTER = "*";
/** Trailing characters left visible so a pasted key can be recognized. */
export const SECRET_REVEAL_LONG = 5;
export const SECRET_REVEAL_SHORT = 2;
/** Shortest secret whose last SECRET_REVEAL_LONG characters show: at least as much stays hidden. */
const SECRET_REVEAL_LONG_MIN_LENGTH = 2 * SECRET_REVEAL_LONG;

export interface MaskSecretOptions {
  readonly reveal?: number;
}

function revealLength(value: string, revealLong: number): number {
  if (value.length >= Math.max(SECRET_REVEAL_LONG_MIN_LENGTH, 2 * revealLong)) {
    return revealLong;
  }
  if (value.length > SECRET_REVEAL_SHORT) {
    return SECRET_REVEAL_SHORT;
  }
  return 0;
}

/**
 * One mask character per hidden character, then the revealed tail, so the masked text has the
 * secret's length and a caret index into the value is also an index into the mask.
 */
export function maskSecret(value: string, options?: MaskSecretOptions): string {
  const reveal = revealLength(value, options?.reveal ?? SECRET_REVEAL_LONG);
  const hiddenLength = value.length - reveal;
  return SECRET_MASK_CHARACTER.repeat(hiddenLength) + value.slice(hiddenLength);
}

/** How a text field draws its value: as typed, masked but for its tail, or all bullets. */
export type InputDisplayMode = "plain" | "tail" | "conceal";

/**
 * The text a field shows for `value` and where its caret sits in it. `caret` counts UTF-16 code
 * units, as the input service keeps it.
 */
export function displayedInput(
  value: string,
  caret: number,
  mode: InputDisplayMode,
): { readonly text: string; readonly caret: number } {
  if (mode === "conceal") {
    return { text: concealValue(value), caret: concealValue(value.slice(0, caret)).length };
  }
  if (mode === "tail") {
    return { text: maskSecret(value), caret };
  }
  return { text: value, caret };
}
