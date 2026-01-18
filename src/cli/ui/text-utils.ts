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
 * @example
 * ```ts
 * findPrevWordBoundary("hello world", 11) // Returns 6 (start of "world")
 * findPrevWordBoundary("hello world", 6)  // Returns 0 (start of "hello")
 * findPrevWordBoundary("hello   world", 8) // Returns 0 (skips spaces to "hello")
 * ```
 */
export function findPrevWordBoundary(value: string, cursor: number): number {
  if (cursor === 0) return 0;

  let i = cursor;

  // If we're in the middle or end of a word, skip to its start
  const charBefore = value[i - 1];
  if (i > 0 && charBefore !== undefined && isWordChar(charBefore)) {
    while (i > 0) {
      const char = value[i - 1];
      if (char === undefined || !isWordChar(char)) break;
      i--;
    }
    return i;
  }

  // Skip backward through non-word characters
  while (i > 0) {
    const char = value[i - 1];
    if (char === undefined || isWordChar(char)) break;
    i--;
  }

  // Skip backward through word characters to find the start
  while (i > 0) {
    const char = value[i - 1];
    if (char === undefined || !isWordChar(char)) break;
    i--;
  }

  return i;
}

/**
 * Find the end of the next word.
 * Matches macOS Option+Right behavior.
 *
 * @param value - The string to search within
 * @param cursor - Current cursor position
 * @returns New cursor position at the end of the next word
 *
 * @example
 * ```ts
 * findNextWordBoundary("hello world", 0)  // Returns 5 (end of "hello")
 * findNextWordBoundary("hello world", 5)  // Returns 11 (end of "world")
 * findNextWordBoundary("hello   world", 5) // Returns 13 (skips spaces to end of "world")
 * ```
 */
export function findNextWordBoundary(value: string, cursor: number): number {
  if (cursor >= value.length) return value.length;

  let i = cursor;

  // If we're in the middle or start of a word, skip to its end
  const charAt = value[i];
  if (i < value.length && charAt !== undefined && isWordChar(charAt)) {
    while (i < value.length) {
      const char = value[i];
      if (char === undefined || !isWordChar(char)) break;
      i++;
    }
    return i;
  }

  // Skip forward through non-word characters
  while (i < value.length) {
    const char = value[i];
    if (char === undefined || isWordChar(char)) break;
    i++;
  }

  // Skip forward through word characters to find the end
  while (i < value.length) {
    const char = value[i];
    if (char === undefined || !isWordChar(char)) break;
    i++;
  }

  return i;
}
