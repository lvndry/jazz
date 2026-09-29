import { concealValue } from "@jazz/core/presentation/concealed-line";

export { concealValue };

export const SECRET_MASK_PREFIX = "***";
export const SECRET_REVEAL_LONG = 6;
export const SECRET_REVEAL_SHORT = 2;

export interface MaskSecretOptions {
  readonly reveal?: number;
}

function revealLength(value: string, revealLong: number): number {
  if (value.length >= revealLong) {
    return revealLong;
  }
  if (value.length > SECRET_REVEAL_SHORT) {
    return SECRET_REVEAL_SHORT;
  }
  return 0;
}

export function maskSecret(value: string, options?: MaskSecretOptions): string {
  if (value.length === 0) {
    return "";
  }
  const reveal = revealLength(value, options?.reveal ?? SECRET_REVEAL_LONG);
  if (reveal === 0) {
    return SECRET_MASK_PREFIX;
  }
  return SECRET_MASK_PREFIX + value.slice(-reveal);
}

export function maskSecretCaret(value: string, caret: number, options?: MaskSecretOptions): number {
  if (value.length === 0) {
    return 0;
  }
  const reveal = revealLength(value, options?.reveal ?? SECRET_REVEAL_LONG);
  const hiddenLength = value.length - reveal;
  const clamped = Math.max(0, Math.min(caret, value.length));
  if (clamped <= hiddenLength) {
    return clamped === 0 ? 0 : SECRET_MASK_PREFIX.length;
  }
  return SECRET_MASK_PREFIX.length + (clamped - hiddenLength);
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
    return { text: maskSecret(value), caret: maskSecretCaret(value, caret) };
  }
  return { text: value, caret };
}
