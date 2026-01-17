import { Text, useInput } from "ink";
import React, { useEffect, useRef, useState } from "react";

/**
 * Text input component with readline-style shortcuts.
 * Based on ink-text-input with added word-level operations.
 */

// ANSI escape character (ESC)
const ESC = String.fromCharCode(0x1b);

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
  const escapeBufferRef = useRef("");

  // Track the latest value and cursor to avoid race conditions during fast typing
  const valueRef = useRef(originalValue);
  const cursorRef = useRef(cursorOffset);

  // Sync refs with state
  useEffect(() => {
    valueRef.current = originalValue;
  }, [originalValue]);

  useEffect(() => {
    cursorRef.current = cursorOffset;
  }, [cursorOffset]);

  // Keep cursor in bounds when value changes externally
  useEffect(() => {
    setCursorOffset((prev) => {
      if (prev > originalValue.length) {
        return originalValue.length;
      }
      return prev;
    });
  }, [originalValue]);

  // Cleanup: Reset escape buffer when component unmounts or value is cleared
  // This prevents state accumulation over long conversations
  useEffect(() => {
    if (originalValue.length === 0) {
      escapeBufferRef.current = "";
    }
  }, [originalValue]);

  useInput(
    (input, key) => {
      // Use refs to get the most up-to-date values during fast typing
      const currentValue = valueRef.current;
      const currentCursor = cursorRef.current;
      // Handle escape sequences for Option+Arrow keys
      // Option+Left can send: \x1b[1;3D, \x1b[1;9D, \x1b[3D, or \x1bb (ESC b)
      // Option+Right can send: \x1b[1;3C, \x1b[1;9C, \x1b[3C, or \x1bf (ESC f)
      let isOptionLeft = false;
      let isOptionRight = false;

      // Check for ESC b (Option+Left) and ESC f (Option+Right) - these are single character sequences
      // These are the most common macOS terminal mappings
      if (input === "\x1bb") {
        isOptionLeft = true;
        escapeBufferRef.current = "";
      } else if (input === "\x1bf") {
        isOptionRight = true;
        escapeBufferRef.current = "";
      }
      // Check if we're building an escape sequence character by character
      else if (input === "\x1b" || escapeBufferRef.current.length > 0) {
        const newBuffer = escapeBufferRef.current + input;

        // Check for complete Option+Left sequences
        // Common patterns: \x1b[1;3D, \x1b[1;9D, \x1b[3D, \x1b[1;5D, \x1b[5D
        const isLeftSequence =
          newBuffer === "\x1b[1;3D" ||
          newBuffer === "\x1b[1;9D" ||
          newBuffer === "\x1b[3D" ||
          newBuffer === "\x1b[1;5D" ||
          newBuffer === "\x1b[5D" ||
          new RegExp(`^${ESC}\\[(\\d+;)?[359]D$`).test(newBuffer);

        // Check for complete Option+Right sequences
        // Common patterns: \x1b[1;3C, \x1b[1;9C, \x1b[3C, \x1b[1;5C, \x1b[5C
        const isRightSequence =
          newBuffer === "\x1b[1;3C" ||
          newBuffer === "\x1b[1;9C" ||
          newBuffer === "\x1b[3C" ||
          newBuffer === "\x1b[1;5C" ||
          newBuffer === "\x1b[5C" ||
          new RegExp(`^${ESC}\\[(\\d+;)?[359]C$`).test(newBuffer);

        if (isLeftSequence) {
          isOptionLeft = true;
          escapeBufferRef.current = "";
        } else if (isRightSequence) {
          isOptionRight = true;
          escapeBufferRef.current = "";
        }
        // Check if we're still building a valid escape sequence
        else if (
          newBuffer === "\x1b" ||
          (newBuffer.startsWith("\x1b[") && newBuffer.length <= 12) ||
          (newBuffer.length <= 2 && new RegExp(`^${ESC}(b|f)$`).test(newBuffer))
        ) {
          // Still building the sequence, wait for more input
          escapeBufferRef.current = newBuffer;
          return;
        }
        // Invalid or unrecognized sequence - clear buffer and process as regular input
        // This handles cases where an incomplete escape sequence is followed by regular characters
        else {
          escapeBufferRef.current = "";
          // Continue processing - the input will be handled as regular input below
        }
      }
      // Check if input contains escape sequences (some terminals send them all at once)
      else if (input.includes("\x1b")) {
        // Check for Option+Left patterns in the input string
        if (
          input.includes("\x1bb") ||
          new RegExp(`${ESC}\\[(\\d+;)?[359]D`).test(input) ||
          new RegExp(`${ESC}\\[(\\d+;)?5D`).test(input)
        ) {
          isOptionLeft = true;
          escapeBufferRef.current = "";
        }
        // Check for Option+Right patterns in the input string
        else if (
          input.includes("\x1bf") ||
          new RegExp(`${ESC}\\[(\\d+;)?[359]C`).test(input) ||
          new RegExp(`${ESC}\\[(\\d+;)?5C`).test(input)
        ) {
          isOptionRight = true;
          escapeBufferRef.current = "";
        } else {
          // Contains escape character but doesn't match our patterns - clear buffer
          escapeBufferRef.current = "";
        }
      }

      // Ignore certain keys
      if (key.upArrow || key.downArrow || (key.ctrl && input === "c") || key.tab) {
        return;
      }

      // Submit
      if (key.return) {
        onSubmit(currentValue);
        return;
      }

      let nextCursorOffset = currentCursor;
      let nextValue = currentValue;

      // --- Word-level operations (Option/Alt = meta) ---

      // Option+Left: jump word left
      // Check both key.meta (when terminal is configured correctly) and escape sequences
      if ((key.meta && key.leftArrow) || isOptionLeft) {
        nextCursorOffset = findPrevWordBoundary(currentValue, currentCursor);
        // Clamp cursor
        if (nextCursorOffset < 0) {
          nextCursorOffset = 0;
        }
        if (nextCursorOffset > currentValue.length) {
          nextCursorOffset = currentValue.length;
        }
        setCursorOffset(nextCursorOffset);
        cursorRef.current = nextCursorOffset;
        return;
      }
      // Option+Right: jump word right
      else if ((key.meta && key.rightArrow) || isOptionRight) {
        nextCursorOffset = findNextWordBoundary(currentValue, currentCursor);
        // Clamp cursor
        if (nextCursorOffset < 0) {
          nextCursorOffset = 0;
        }
        if (nextCursorOffset > currentValue.length) {
          nextCursorOffset = currentValue.length;
        }
        setCursorOffset(nextCursorOffset);
        cursorRef.current = nextCursorOffset;
        return;
      }
      // Option+Backspace or Ctrl+W: delete word backward
      else if ((key.meta && key.backspace) || (key.ctrl && input === "w")) {
        const boundary = findPrevWordBoundary(currentValue, currentCursor);
        nextValue = currentValue.slice(0, boundary) + currentValue.slice(currentCursor);
        nextCursorOffset = boundary;
      }
      // Option+Delete: delete word forward
      else if (key.meta && key.delete) {
        const boundary = findNextWordBoundary(currentValue, currentCursor);
        nextValue = currentValue.slice(0, currentCursor) + currentValue.slice(boundary);
      }
      // --- Readline shortcuts ---
      // Ctrl+A: beginning of line
      else if (key.ctrl && input === "a") {
        nextCursorOffset = 0;
      }
      // Ctrl+E: end of line
      else if (key.ctrl && input === "e") {
        nextCursorOffset = currentValue.length;
      }
      // Ctrl+U: kill line backward
      else if (key.ctrl && input === "u") {
        nextValue = currentValue.slice(currentCursor);
        nextCursorOffset = 0;
      }
      // Ctrl+K: kill line forward
      else if (key.ctrl && input === "k") {
        nextValue = currentValue.slice(0, currentCursor);
      }
      // Ctrl+D: delete char forward
      else if (key.ctrl && input === "d") {
        if (currentCursor < currentValue.length) {
          nextValue = currentValue.slice(0, currentCursor) + currentValue.slice(currentCursor + 1);
        }
      }
      // --- Basic navigation ---
      else if (key.leftArrow) {
        if (showCursor) {
          nextCursorOffset--;
        }
      } else if (key.rightArrow) {
        if (showCursor) {
          nextCursorOffset++;
        }
      }
      // --- Deletion ---
      else if (key.backspace || key.delete) {
        if (currentCursor > 0) {
          nextValue = currentValue.slice(0, currentCursor - 1) + currentValue.slice(currentCursor);
          nextCursorOffset--;
        }
      }
      // --- Regular input ---
      // Skip if we detected an escape sequence (Option+Arrow) to prevent processing as regular input
      else if (!key.ctrl && !key.meta && !isOptionLeft && !isOptionRight && !input.includes("\x1b")) {
        nextValue =
          currentValue.slice(0, currentCursor) + input + currentValue.slice(currentCursor);
        nextCursorOffset += input.length;
      }

      // Clamp cursor
      if (nextCursorOffset < 0) {
        nextCursorOffset = 0;
      }
      if (nextCursorOffset > nextValue.length) {
        nextCursorOffset = nextValue.length;
      }

      // Update refs immediately for next keystroke
      cursorRef.current = nextCursorOffset;
      valueRef.current = nextValue;

      setCursorOffset(nextCursorOffset);

      if (nextValue !== currentValue) {
        onChange(nextValue);
      }
    },
    { isActive: focus },
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
      {value.length > 0 ? renderedValue : placeholder ? renderedPlaceholder : renderedValue}
    </Text>
  );
}
