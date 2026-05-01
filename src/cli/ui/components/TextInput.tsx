import { Box, Text, useInput } from "ink";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTextInput } from "../hooks/use-input-service";
import { THEME } from "../theme";

/** Build display string for masked input; length always matches `value` for cursor alignment. */
function formatMaskedDisplayValue(
  value: string,
  maskChar: string,
  revealTailCount?: number,
): string {
  const n = value.length;
  if (n === 0) {
    return "";
  }
  if (revealTailCount === undefined || revealTailCount <= 0) {
    return maskChar.repeat(n);
  }
  const tailLen = Math.min(revealTailCount, n);
  const hiddenLen = n - tailLen;
  return maskChar.repeat(hiddenLen) + value.slice(-tailLen);
}

export interface TextInputProps {
  /** Unique identifier for this input (used to prevent state sharing) */
  inputId: string;
  defaultValue?: string;
  placeholder?: string;
  /** Mask character for password input (e.g., "*") */
  mask?: string;
  /** When set with `mask`, show this many characters from the end in plaintext (rest stay masked). */
  maskRevealTail?: number;
  validate?: (input: string) => boolean | string;
  onSubmit: (value: string) => void;
  onCancel?: () => void;
}

/**
 * A minimalistic inline text input for wizard prompts.
 * Just the input field with cursor - no message, no borders, no hints.
 * The parent Prompt component handles rendering the message.
 *
 * Single-line only: Enter submits, newlines are not inserted.
 */
export const TextInput = React.memo(function TextInput({
  inputId,
  defaultValue = "",
  placeholder = "",
  mask,
  maskRevealTail,
  validate,
  onSubmit,
  onCancel,
}: TextInputProps): React.ReactElement {
  const [validationError, setValidationError] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);
  const onSubmitRef = useRef(onSubmit);
  const validateRef = useRef(validate);
  const onCancelRef = useRef(onCancel);
  const valueWhenValidationFailedRef = useRef<string | null>(null);

  // Keep refs up to date
  onSubmitRef.current = onSubmit;
  validateRef.current = validate;
  onCancelRef.current = onCancel;

  // Handle submit with validation
  const handleSubmit = useCallback((val: string) => {
    if (validateRef.current) {
      const result = validateRef.current(val);
      if (result !== true) {
        setValidationError(typeof result === "string" ? result : "Invalid input");
        valueWhenValidationFailedRef.current = val;
        return;
      }
    }
    setValidationError(null);
    valueWhenValidationFailedRef.current = null;
    onSubmitRef.current(val);
  }, []);

  // Use inputId to prevent state sharing between different simple text inputs
  const uniqueId = useMemo(
    () => `simple-text-input-${inputId.replace(/\s+/g, "-").toLowerCase()}`,
    [inputId],
  );

  // Initialize with default value
  const { value, cursor, setValue } = useTextInput({
    id: uniqueId,
    isActive: true,
    onSubmit: handleSubmit,
  });

  // Set default value on mount, or clear value if no default
  useEffect(() => {
    if (!initialized) {
      setValue(defaultValue, defaultValue.length);
      setInitialized(true);
    }
  }, [defaultValue, setValue, initialized]);

  // Handle ESC key for cancellation
  useInput((_input: string, key: { escape?: boolean }) => {
    if (key.escape && onCancelRef.current) {
      onCancelRef.current();
    }
  });

  useEffect(() => {
    const snapshot = valueWhenValidationFailedRef.current;
    if (validationError === null || snapshot === null) {
      return;
    }
    if (value !== snapshot) {
      setValidationError(null);
      valueWhenValidationFailedRef.current = null;
    }
  }, [value, validationError]);

  // Render value with a visible block cursor (works in any terminal theme)
  const renderValue = () => {
    if (value.length === 0 && placeholder.length > 0) {
      return (
        <Text color="gray">
          <Text inverse>{placeholder[0] || " "}</Text>
          {placeholder.slice(1)}
        </Text>
      );
    }

    const displayValue = mask ? formatMaskedDisplayValue(value, mask, maskRevealTail) : value;

    const beforeCursor = displayValue.slice(0, cursor);
    const cursorChar = cursor < displayValue.length ? displayValue[cursor] : " ";
    const afterCursor = cursor < displayValue.length ? displayValue.slice(cursor + 1) : "";

    return (
      <>
        {beforeCursor && <Text>{beforeCursor}</Text>}
        <Text
          inverse
          color={THEME.primary}
        >
          {cursorChar}
        </Text>
        {afterCursor && <Text>{afterCursor}</Text>}
      </>
    );
  };

  return (
    <Box flexDirection="column">
      {/* Just the input - message is rendered by parent Prompt component */}
      <Box>
        <Text color={THEME.primary}>{"> "}</Text>
        {renderValue()}
      </Box>

      {/* Validation error on separate line */}
      {validationError && (
        <Box paddingLeft={3}>
          <Text color="red">✗ {validationError}</Text>
        </Box>
      )}
    </Box>
  );
});
