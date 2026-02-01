import { Box, Text } from "ink";
import React, { useCallback, useState } from "react";
import { useTextInput } from "../../hooks/use-input-service";
import { findNextWordBoundary, findPrevWordBoundary } from "../../text-utils";

// ============================================================================
// Types
// ============================================================================

interface TextInputProps {
  /** Current value */
  value: string;
  /** Callback when value changes */
  onChange: (value: string) => void;
  /** Callback when Enter is pressed */
  onSubmit: (value: string) => void;
  /** Mask character for password input */
  mask?: string;
  /** Placeholder text */
  placeholder?: string;
  /** Show cursor */
  showCursor?: boolean;
  /** Whether input is focused/active */
  focus?: boolean;
}

// ============================================================================
// Constants
// ============================================================================

/** Exported so parents can render hints below the input box (keeps selection inside box to input text only). */
export const SHORTCUTS_HINT =
  "Ctrl+A/E: start/end · Ctrl+U/K: clear · Opt+←/→: word nav · Opt+Del: delete word";

// ============================================================================
// Component
// ============================================================================

/**
 * TextInput component using the new InputService architecture.
 *
 * Key improvements over LineInput:
 * - No internal useInput - delegates to centralized InputService
 * - No escape buffer management - handled by EscapeStateMachine
 * - No race conditions - synchronous state machine
 * - Cursor state in React state - no refs during render
 */
export function TextInput({
  value,
  onChange,
  onSubmit,
  mask,
  placeholder = "",
  showCursor = true,
  focus = true,
}: TextInputProps): React.ReactElement {
  const [cursor, setCursor] = useState(value.length);

  // Handle value and cursor changes
  const handleChange = useCallback(
    (newValue: string, newCursor: number) => {
      setCursor(newCursor);
      if (newValue !== value) {
        onChange(newValue);
      }
    },
    [value, onChange],
  );

  // Handle submit
  const handleSubmit = useCallback(
    (currentValue: string) => {
      onSubmit(currentValue);
    },
    [onSubmit],
  );

  // Track value we set via onChange to distinguish external updates (e.g. command suggestion selection)
  const lastValueWeSetRef = React.useRef<string | null>(null);

  // Register text input handler; use ref-backed display value/cursor so we never show stale state
  // when re-renders (logs, stream) run before our setState commits (fixes ordering in long chats).
  const { displayValue, displayCursor } = useTextInput({
    id: "text-input",
    value,
    cursor,
    isActive: focus,
    onChange: (newValue, newCursor) => {
      lastValueWeSetRef.current = newValue;
      handleChange(newValue, newCursor);
    },
    onSubmit: handleSubmit,
    findPrevWordBoundary,
    findNextWordBoundary,
  });

  // Sync cursor when value changes externally (e.g., command suggestion selection, clear on submit)
  React.useEffect(() => {
    if (cursor > value.length) {
      setCursor(value.length);
    } else if (lastValueWeSetRef.current !== value) {
      lastValueWeSetRef.current = value;
      setCursor(value.length);
    } else {
      lastValueWeSetRef.current = null;
    }
  }, [value, cursor]);

  // Render from displayValue/displayCursor (ref-backed) so we never flash stale state
  const displayValueMasked = mask ? mask.repeat(displayValue.length) : displayValue;

  let renderedValue: React.ReactNode = displayValueMasked;
  let renderedPlaceholder: React.ReactNode = placeholder ? (
    <Text dimColor>{placeholder}</Text>
  ) : null;

  if (showCursor && focus) {
    // Placeholder with cursor
    if (placeholder.length > 0 && displayValueMasked.length === 0) {
      renderedPlaceholder = (
        <Text>
          <Text inverse>{placeholder[0]}</Text>
          <Text dimColor>{placeholder.slice(1)}</Text>
        </Text>
      );
    } else if (displayValueMasked.length === 0) {
      renderedPlaceholder = <Text inverse> </Text>;
    }

    // Value with cursor
    if (displayValueMasked.length > 0) {
      const before = displayValueMasked.slice(0, displayCursor);
      const cursorChar = displayCursor < displayValueMasked.length ? displayValueMasked[displayCursor] : " ";
      const after = displayCursor < displayValueMasked.length ? displayValueMasked.slice(displayCursor + 1) : "";

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

  // Render only the input line (displayValueMasked so we never show stale state) so the bordered box contains just this text.
  // Parent renders directory + shortcuts below the box so terminal selection
  // inside the box captures only the input text.
  return (
    <Box>
      <Text>
        {displayValueMasked.length > 0
          ? renderedValue
          : placeholder
            ? renderedPlaceholder
            : renderedValue}
      </Text>
    </Box>
  );
}

// ============================================================================
// Exports
// ============================================================================

export default TextInput;
export type { TextInputProps };
