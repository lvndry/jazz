import { Box, Text, useInput } from "ink";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTextInput } from "../hooks/use-input-service";
import { maskSecret, maskSecretCaret } from "../mask-secret";
import { THEME } from "../theme";

export interface TextInputProps {
  /** Unique identifier for this input (used to prevent state sharing) */
  inputId: string;
  defaultValue?: string;
  placeholder?: string;
  /** When set, display a masked value (last 6 characters, or last 2 if shorter). */
  mask?: string;
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
        <Text
          color={THEME.muted}
          wrap="wrap"
        >
          <Text inverse>{placeholder[0] || " "}</Text>
          {placeholder.slice(1)}
        </Text>
      );
    }

    const displayValue = mask ? maskSecret(value) : value;
    const displayCaret = mask ? maskSecretCaret(value, cursor) : cursor;

    const beforeCursor = displayValue.slice(0, displayCaret);
    const cursorChar = displayCaret < displayValue.length ? displayValue[displayCaret] : " ";
    const afterCursor =
      displayCaret < displayValue.length ? displayValue.slice(displayCaret + 1) : "";

    return (
      <Text wrap="wrap">
        {beforeCursor}
        <Text
          inverse
          color={THEME.primary}
        >
          {cursorChar}
        </Text>
        {afterCursor}
      </Text>
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
          <Text color={THEME.error}>✗ {validationError}</Text>
        </Box>
      )}
    </Box>
  );
});
