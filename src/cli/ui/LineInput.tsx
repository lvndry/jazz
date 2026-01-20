import { Box, Text, useInput } from "ink";
import React, { useEffect, useRef, useState } from "react";
import { parseInput, type KeyInfo } from "./escape-sequence-parser";
import { findNextWordBoundary, findPrevWordBoundary } from "./text-utils";

/**
 * Text input component with readline-style shortcuts.
 * Based on ink-text-input with added word-level operations.
 */

interface LineInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  mask?: string;
  placeholder?: string;
  showCursor?: boolean;
  focus?: boolean;
}

// Keyboard shortcuts hint for display
const SHORTCUTS_HINT = "Ctrl+A/E: start/end · Ctrl+U/K: clear · Opt+←/→: word nav · Opt+Del: delete word";

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

  // Refs for synchronous access during input processing
  const valueRef = useRef(originalValue);
  const cursorRef = useRef(cursorOffset);
  const escapeBufferRef = useRef("");

  // Sync refs when value changes externally
  if (originalValue !== valueRef.current) {
    valueRef.current = originalValue;
    if (cursorRef.current > originalValue.length) {
      cursorRef.current = originalValue.length;
    }
  }

  if (cursorOffset !== cursorRef.current && cursorOffset <= valueRef.current.length) {
    cursorRef.current = cursorOffset;
  }

  useEffect(() => {
    if (originalValue.length === 0) {
      escapeBufferRef.current = "";
    }
  }, [originalValue]);

  useInput(
    (input, key) => {
      const currentValue = valueRef.current;
      const currentCursor = cursorRef.current;

      // Parse input using the escape sequence parser
      const keyInfo: KeyInfo = {
        upArrow: key.upArrow,
        downArrow: key.downArrow,
        leftArrow: key.leftArrow,
        rightArrow: key.rightArrow,
        return: key.return,
        escape: key.escape,
        ctrl: key.ctrl,
        shift: key.shift,
        tab: key.tab,
        backspace: key.backspace,
        delete: key.delete,
        meta: key.meta,
      };

      const { parsed, newBuffer } = parseInput(input, keyInfo, escapeBufferRef.current);
      escapeBufferRef.current = newBuffer;

      let nextCursor = currentCursor;
      let nextValue = currentValue;

      switch (parsed.type) {
        case "buffering":
        case "ignore":
          return;

        case "submit":
          onSubmit(currentValue);
          return;

        case "word-left":
          nextCursor = findPrevWordBoundary(currentValue, currentCursor);
          break;

        case "word-right":
          nextCursor = findNextWordBoundary(currentValue, currentCursor);
          break;

        case "delete-word-back": {
          const boundary = findPrevWordBoundary(currentValue, currentCursor);
          nextValue = currentValue.slice(0, boundary) + currentValue.slice(currentCursor);
          nextCursor = boundary;
          break;
        }

        case "delete-word-forward": {
          const boundary = findNextWordBoundary(currentValue, currentCursor);
          nextValue = currentValue.slice(0, currentCursor) + currentValue.slice(boundary);
          break;
        }

        case "line-start":
          nextCursor = 0;
          break;

        case "line-end":
          nextCursor = currentValue.length;
          break;

        case "kill-line-back":
          nextValue = currentValue.slice(currentCursor);
          nextCursor = 0;
          break;

        case "kill-line-forward":
          nextValue = currentValue.slice(0, currentCursor);
          break;

        case "delete-char-forward":
          if (currentCursor < currentValue.length) {
            nextValue = currentValue.slice(0, currentCursor) + currentValue.slice(currentCursor + 1);
          }
          break;

        case "left":
          if (showCursor) nextCursor--;
          break;

        case "right":
          if (showCursor) nextCursor++;
          break;

        case "backspace":
          if (currentCursor > 0) {
            nextValue = currentValue.slice(0, currentCursor - 1) + currentValue.slice(currentCursor);
            nextCursor--;
          }
          break;

        case "char":
          nextValue = currentValue.slice(0, currentCursor) + parsed.char + currentValue.slice(currentCursor);
          nextCursor += parsed.char.length;
          break;
      }

      // Clamp cursor
      nextCursor = Math.max(0, Math.min(nextCursor, nextValue.length));

      // Update if changed
      const valueChanged = nextValue !== currentValue;
      const cursorChanged = nextCursor !== currentCursor;

      if (valueChanged || cursorChanged) {
        cursorRef.current = nextCursor;
        valueRef.current = nextValue;
        setCursorOffset(nextCursor);

        if (valueChanged) {
          onChange(nextValue);
        }
      }
    },
    { isActive: focus },
  );

  // Render
  const displayValue = valueRef.current;
  const displayCursor = cursorRef.current;
  const value = mask ? mask.repeat(displayValue.length) : displayValue;

  let renderedValue: React.ReactNode = value;
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
      );
    } else {
      renderedValue = <Text inverse> </Text>;
    }
  }

  return (
    <Box flexDirection="column">
      <Text>
        {value.length > 0 ? renderedValue : placeholder ? renderedPlaceholder : renderedValue}
      </Text>
      {focus && value.length === 0 && (
        <Text dimColor>{SHORTCUTS_HINT}</Text>
      )}
    </Box>
  );
}

