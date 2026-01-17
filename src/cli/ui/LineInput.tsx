import { Text, useInput } from "ink";
import React, { useEffect, useState } from "react";

/**
 * Text input component with readline-style shortcuts.
 * Based on ink-text-input with added word-level operations.
 */

/** Find the start of the previous word */
function findPrevWordBoundary(value: string, cursor: number): number {
  if (cursor === 0) return 0;
  let i = cursor;
  while (i > 0 && value[i - 1] === " ") i--;
  while (i > 0 && value[i - 1] !== " ") i--;
  return i;
}

/** Find the end of the next word */
function findNextWordBoundary(value: string, cursor: number): number {
  if (cursor >= value.length) return value.length;
  let i = cursor;
  while (i < value.length && value[i] !== " ") i++;
  while (i < value.length && value[i] === " ") i++;
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
