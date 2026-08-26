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
