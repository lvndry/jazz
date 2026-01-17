import { Text, useInput } from "ink";
import React, { useEffect, useRef, useState } from "react";

/**
 * Text input component with readline-style shortcuts.
 * Based on ink-text-input with added word-level operations.
 */

// ANSI escape character (ESC)
const ESC = String.fromCharCode(0x1b);

// Pre-compiled regex patterns for escape sequence detection (avoid creating on every keystroke)
const OPTION_LEFT_REGEX = new RegExp(`^${ESC}\\[(\\d+;)?[359]D$`);
const OPTION_RIGHT_REGEX = new RegExp(`^${ESC}\\[(\\d+;)?[359]C$`);
const ESC_BF_REGEX = new RegExp(`^${ESC}(b|f)$`);
const OPTION_LEFT_INPUT_REGEX = new RegExp(`${ESC}\\[(\\d+;)?[359]D`);
const OPTION_LEFT_INPUT_5D_REGEX = new RegExp(`${ESC}\\[(\\d+;)?5D`);
const OPTION_RIGHT_INPUT_REGEX = new RegExp(`${ESC}\\[(\\d+;)?[359]C`);
const OPTION_RIGHT_INPUT_5C_REGEX = new RegExp(`${ESC}\\[(\\d+;)?5C`);

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
  // Internal state for cursor position - this drives re-renders
  const [cursorOffset, setCursorOffset] = useState(originalValue.length);

  // Refs are the source of truth during input processing
  // They're updated synchronously to ensure no input is lost during fast typing
  const valueRef = useRef(originalValue);
  const cursorRef = useRef(cursorOffset);
  const escapeBufferRef = useRef("");

  // Sync refs when value changes externally (from parent)
  // This handles cases like form reset or programmatic value changes
  if (originalValue !== valueRef.current) {
    valueRef.current = originalValue;
    // Adjust cursor if it's out of bounds
    if (cursorRef.current > originalValue.length) {
      cursorRef.current = originalValue.length;
    }
  }

  // Sync cursor ref with state (for cases where state updates from external sources)
  if (cursorOffset !== cursorRef.current && cursorOffset <= valueRef.current.length) {
    cursorRef.current = cursorOffset;
  }

  // Cleanup: Reset escape buffer when value is cleared
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
          OPTION_LEFT_REGEX.test(newBuffer);

        // Check for complete Option+Right sequences
        // Common patterns: \x1b[1;3C, \x1b[1;9C, \x1b[3C, \x1b[1;5C, \x1b[5C
        const isRightSequence =
          newBuffer === "\x1b[1;3C" ||
          newBuffer === "\x1b[1;9C" ||
          newBuffer === "\x1b[3C" ||
          newBuffer === "\x1b[1;5C" ||
          newBuffer === "\x1b[5C" ||
          OPTION_RIGHT_REGEX.test(newBuffer);

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
          (newBuffer.length <= 2 && ESC_BF_REGEX.test(newBuffer))
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
          OPTION_LEFT_INPUT_REGEX.test(input) ||
          OPTION_LEFT_INPUT_5D_REGEX.test(input)
        ) {
          isOptionLeft = true;
          escapeBufferRef.current = "";
        }
        // Check for Option+Right patterns in the input string
        else if (
          input.includes("\x1bf") ||
          OPTION_RIGHT_INPUT_REGEX.test(input) ||
          OPTION_RIGHT_INPUT_5C_REGEX.test(input)
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

      // Update refs immediately - these are the source of truth
      // This ensures subsequent keystrokes always work with the latest values
      const valueChanged = nextValue !== currentValue;
      const cursorChanged = nextCursorOffset !== currentCursor;

      if (valueChanged || cursorChanged) {
        // Update refs synchronously for next keystroke
        cursorRef.current = nextCursorOffset;
        valueRef.current = nextValue;

        // Trigger re-render via cursor state update
        // This is the single state update that drives rendering
        setCursorOffset(nextCursorOffset);

        // Notify parent of value change
        if (valueChanged) {
          onChange(nextValue);
        }
      }
    },
    { isActive: focus },
  );

  // Render using refs as source of truth for immediate visual feedback
  // Use the ref value to ensure we always render the latest input
  const displayValue = valueRef.current;
  const displayCursor = cursorRef.current;
  const value = mask ? mask.repeat(displayValue.length) : displayValue;

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
      const before = value.slice(0, displayCursor);
      const cursorChar = displayCursor < value.length ? value[displayCursor] : " ";
      const after = displayCursor < value.length ? value.slice(displayCursor + 1) : "";

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
