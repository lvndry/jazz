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
  /** Current working directory to display above the hint */
  currentDirectory?: string | null;
}

// ============================================================================
// Constants
// ============================================================================

const SHORTCUTS_HINT =
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
  currentDirectory = null,
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

  // Register text input handler with InputService
  useTextInput({
    id: "text-input",
    value,
    cursor,
    isActive: focus,
    onChange: handleChange,
    onSubmit: handleSubmit,
    findPrevWordBoundary,
    findNextWordBoundary,
  });

  // Sync cursor when value changes externally (e.g., clear on submit)
  React.useEffect(() => {
    if (cursor > value.length) {
      setCursor(value.length);
    }
  }, [value, cursor]);

  // Render
  const displayValue = mask ? mask.repeat(value.length) : value;

  let renderedValue: React.ReactNode = displayValue;
  let renderedPlaceholder: React.ReactNode = placeholder ? (
    <Text dimColor>{placeholder}</Text>
  ) : null;

  if (showCursor && focus) {
    // Placeholder with cursor
    if (placeholder.length > 0 && displayValue.length === 0) {
      renderedPlaceholder = (
        <Text>
          <Text inverse>{placeholder[0]}</Text>
          <Text dimColor>{placeholder.slice(1)}</Text>
        </Text>
      );
    } else if (displayValue.length === 0) {
      renderedPlaceholder = <Text inverse> </Text>;
    }

    // Value with cursor
    if (displayValue.length > 0) {
      const before = displayValue.slice(0, cursor);
      const cursorChar = cursor < displayValue.length ? displayValue[cursor] : " ";
      const after = cursor < displayValue.length ? displayValue.slice(cursor + 1) : "";

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
        {displayValue.length > 0
          ? renderedValue
          : placeholder
            ? renderedPlaceholder
            : renderedValue}
      </Text>
      {focus && (
        <Box marginTop={1} flexDirection="column">
          {currentDirectory && (
            <Text dimColor>Current directory: {currentDirectory}</Text>
          )}
          <Text dimColor>{SHORTCUTS_HINT}</Text>
        </Box>
      )}
    </Box>
  );
}

// ============================================================================
// Exports
// ============================================================================

export default TextInput;
export type { TextInputProps };
