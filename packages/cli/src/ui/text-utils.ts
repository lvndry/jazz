/**
 * Text manipulation utilities for terminal input.
 *
 * These functions implement macOS-style word boundary detection
 * for readline-style navigation (Option+Left/Right).
 */

/**
 * Check if a character is alphanumeric (word character).
 * Matches macOS word boundary behavior.
 *
 * @param char - Single character to check
 * @returns true if the character is a letter, digit, or underscore
 */
export function isWordChar(char: string): boolean {
  return /[a-zA-Z0-9_]/.test(char);
}

/**
 * Find the start of the previous word.
 * Matches macOS Option+Left behavior.
 *
 * @param value - The string to search within
 * @param cursor - Current cursor position
 * @returns New cursor position at the start of the previous word
 *
 */
export function findPrevWordBoundary(value: string, cursor: number): number {
  if (cursor === 0) {
    return 0;
  }

  let index = cursor;

  // If we're in the middle or end of a word, skip to its start
  const charBefore = value[index - 1];
  if (index > 0 && charBefore !== undefined && isWordChar(charBefore)) {
    while (index > 0) {
      const char = value[index - 1];
      if (char === undefined || !isWordChar(char)) {
        break;
      }
      index--;
    }
    return index;
  }

  // Skip backward through non-word characters
  while (index > 0) {
    const char = value[index - 1];
    if (char === undefined || isWordChar(char)) {
      break;
    }
    index--;
  }

  // Skip backward through word characters to find the start
  while (index > 0) {
    const char = value[index - 1];
    if (char === undefined || !isWordChar(char)) {
      break;
    }
    index--;
  }

  return index;
}

/**
 * Find the end of the next word.
 * Matches macOS Option+Right behavior.
 *
 * @param value - The string to search within
 * @param cursor - Current cursor position
 * @returns New cursor position at the end of the next word
 *
 */
export function findNextWordBoundary(value: string, cursor: number): number {
  if (cursor >= value.length) {
    return value.length;
  }

  let index = cursor;

  // If we're in the middle or start of a word, skip to its end
  const charAt = value[index];
  if (index < value.length && charAt !== undefined && isWordChar(charAt)) {
    while (index < value.length) {
      const char = value[index];
      if (char === undefined || !isWordChar(char)) {
        break;
      }
      index++;
    }
    return index;
  }

  // Skip forward through non-word characters
  while (index < value.length) {
    const char = value[index];
    if (char === undefined || isWordChar(char)) {
      break;
    }
    index++;
  }

  // Skip forward through word characters to find the end
  while (index < value.length) {
    const char = value[index];
    if (char === undefined || !isWordChar(char)) {
      break;
    }
    index++;
  }

  return index;
}
