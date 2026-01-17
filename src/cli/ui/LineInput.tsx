import { Text, useInput } from "ink";
import React, { useEffect, useState } from "react";

/**
 * Text input component with readline-style shortcuts.
 * Based on ink-text-input with added word-level operations.
 */

/**
 * Check if a character is alphanumeric (word character).
 * Matches macOS word boundary behavior.
 */
function isWordChar(char: string): boolean {
  return /[a-zA-Z0-9_]/.test(char);
}

/**
 * Find the start of the previous word.
 * Matches macOS Option+Left behavior:
 * - If cursor is in the middle of a word, move to start of that word
 * - If cursor is at the start of a word, move to start of previous word
 * - Word boundaries are defined by alphanumeric vs non-alphanumeric characters
 */
function findPrevWordBoundary(value: string, cursor: number): number {
  if (cursor === 0) return 0;

  let i = cursor;

  // If we're in the middle or end of a word, skip to its start
  const charBefore = value[i - 1];
  if (i > 0 && charBefore !== undefined && isWordChar(charBefore)) {
    // Move backward through word characters
    while (i > 0) {
      const char = value[i - 1];
      if (char === undefined || !isWordChar(char)) break;
      i--;
    }
    return i;
  }

  // Skip backward through non-word characters (spaces, punctuation, etc.)
  while (i > 0) {
    const char = value[i - 1];
    if (char === undefined || isWordChar(char)) break;
    i--;
  }

  // Now skip backward through the word characters to find the start
  while (i > 0) {
    const char = value[i - 1];
    if (char === undefined || !isWordChar(char)) break;
    i--;
  }

  return i;
}

/**
 * Find the end of the next word.
 * Matches macOS Option+Right behavior:
 * - If cursor is in the middle of a word, move to end of that word
 * - If cursor is at the end of a word, move to end of next word
 * - Word boundaries are defined by alphanumeric vs non-alphanumeric characters
 */
function findNextWordBoundary(value: string, cursor: number): number {
  if (cursor >= value.length) return value.length;

  let i = cursor;

  // If we're in the middle or start of a word, skip to its end
  const charAt = value[i];
  if (i < value.length && charAt !== undefined && isWordChar(charAt)) {
    // Move forward through word characters
    while (i < value.length) {
      const char = value[i];
      if (char === undefined || !isWordChar(char)) break;
      i++;
    }
    return i;
  }

  // Skip forward through non-word characters (spaces, punctuation, etc.)
  while (i < value.length) {
    const char = value[i];
    if (char === undefined || isWordChar(char)) break;
    i++;
  }

  // Now skip forward through the word characters to find the end
  while (i < value.length) {
    const char = value[i];
    if (char === undefined || !isWordChar(char)) break;
    i++;
  }

  return i;
}

interface LineInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  mask?: string;
  placeholder?: string;
  showCursor?: boolean;
  focus?: boolean;
}

export function LineInput({
  value: originalValue,
  onChange,
  onSubmit,
  mask,
  placeholder = "",
  showCursor = true,
  focus = true,
}: LineInputProps): React.ReactElement {
  const [cursorOffset, setCursorOffset] = useState(originalValue.length);

  // Keep cursor in bounds when value changes externally
  useEffect(() => {
    setCursorOffset((prev) => {
      if (prev > originalValue.length) {
        return originalValue.length;
      }
      return prev;
    });
  }, [originalValue]);

  useInput(
    (input, key) => {
      // Ignore certain keys
      if (
        key.upArrow ||
        key.downArrow ||
        (key.ctrl && input === "c") ||
        key.tab
      ) {
        return;
      }

      // Submit
      if (key.return) {
        onSubmit(originalValue);
        return;
      }

      let nextCursorOffset = cursorOffset;
      let nextValue = originalValue;

      // --- Word-level operations (Option/Alt = meta) ---

      // Option+Left: jump word left
      if (key.meta && key.leftArrow) {
        nextCursorOffset = findPrevWordBoundary(originalValue, cursorOffset);
      }
      // Option+Right: jump word right
      else if (key.meta && key.rightArrow) {
        nextCursorOffset = findNextWordBoundary(originalValue, cursorOffset);
      }
      // Option+Backspace or Ctrl+W: delete word backward
      else if ((key.meta && key.backspace) || (key.ctrl && input === "w")) {
        const boundary = findPrevWordBoundary(originalValue, cursorOffset);
        nextValue = originalValue.slice(0, boundary) + originalValue.slice(cursorOffset);
        nextCursorOffset = boundary;
      }
      // Option+Delete: delete word forward
      else if (key.meta && key.delete) {
        const boundary = findNextWordBoundary(originalValue, cursorOffset);
        nextValue = originalValue.slice(0, cursorOffset) + originalValue.slice(boundary);
      }
      // --- Readline shortcuts ---
      // Ctrl+A: beginning of line
      else if (key.ctrl && input === "a") {
        nextCursorOffset = 0;
      }
      // Ctrl+E: end of line
      else if (key.ctrl && input === "e") {
        nextCursorOffset = originalValue.length;
      }
      // Ctrl+U: kill line backward
      else if (key.ctrl && input === "u") {
        nextValue = originalValue.slice(cursorOffset);
        nextCursorOffset = 0;
      }
      // Ctrl+K: kill line forward
      else if (key.ctrl && input === "k") {
        nextValue = originalValue.slice(0, cursorOffset);
      }
      // Ctrl+D: delete char forward
      else if (key.ctrl && input === "d") {
        if (cursorOffset < originalValue.length) {
          nextValue = originalValue.slice(0, cursorOffset) + originalValue.slice(cursorOffset + 1);
        }
      }
      // --- Basic navigation ---
      else if (key.leftArrow) {
        if (showCursor) {
          nextCursorOffset--;
        }
      }
      else if (key.rightArrow) {
        if (showCursor) {
          nextCursorOffset++;
        }
      }
      // --- Deletion ---
      else if (key.backspace || key.delete) {
        if (cursorOffset > 0) {
          nextValue =
            originalValue.slice(0, cursorOffset - 1) +
            originalValue.slice(cursorOffset);
          nextCursorOffset--;
        }
      }
      // --- Regular input ---
      else if (!key.ctrl && !key.meta) {
        nextValue =
          originalValue.slice(0, cursorOffset) +
          input +
          originalValue.slice(cursorOffset);
        nextCursorOffset += input.length;
      }

      // Clamp cursor
      if (nextCursorOffset < 0) {
        nextCursorOffset = 0;
      }
      if (nextCursorOffset > nextValue.length) {
        nextCursorOffset = nextValue.length;
      }

      setCursorOffset(nextCursorOffset);

      if (nextValue !== originalValue) {
        onChange(nextValue);
      }
    },
    { isActive: focus }
  );

  // Render
  const value = mask ? mask.repeat(originalValue.length) : originalValue;

  let renderedValue = value;
  let renderedPlaceholder: React.ReactNode = placeholder ? (
    <Text dimColor>{placeholder}</Text>
  ) : null;

  if (showCursor && focus) {
    // Placeholder with cursor
    if (placeholder.length > 0) {
      renderedPlaceholder = (
        <Text>
          <Text inverse>{placeholder[0]}</Text>
          <Text dimColor>{placeholder.slice(1)}</Text>
        </Text>
      );
    } else {
      renderedPlaceholder = <Text inverse> </Text>;
    }

    // Value with cursor
    if (value.length > 0) {
      const before = value.slice(0, cursorOffset);
      const cursorChar = cursorOffset < value.length ? value[cursorOffset] : " ";
      const after = cursorOffset < value.length ? value.slice(cursorOffset + 1) : "";

      renderedValue = (
        <>
          {before}
          <Text inverse>{cursorChar}</Text>
          {after}
        </>
      ) as unknown as string;
    } else {
      renderedValue = (<Text inverse> </Text>) as unknown as string;
    }
  }

  return (
    <Text>
      {value.length > 0 ? renderedValue : (placeholder ? renderedPlaceholder : renderedValue)}
    </Text>
  );
}
