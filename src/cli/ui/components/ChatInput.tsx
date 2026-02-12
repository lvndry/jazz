import { Box, Text } from "ink";
import React from "react";

export interface ChatInputProps {
  /** Current value */
  value: string;
  /** Current cursor position */
  cursor: number;
  /** Mask character for password input */
  mask?: string;
  /** Placeholder text */
  placeholder?: string;
  /** Show cursor */
  showCursor?: boolean;
  /** Whether input is focused/active */
  focus?: boolean;
  /** Text color */
  textColor?: string;
}

/** Exported so parents can render hints below the input box (keeps selection inside box to input text only). */
export const SHORTCUTS_HINT =
  "Ctrl+A/E: start/end · Ctrl+U/K: clear · Opt+←/→: word nav · Opt+Del: delete word";

/**
 * TextInput component that renders the current input value.
 *
 * Input handling and state live in the InputService; this component is
 * purely presentational to avoid reordering under heavy render pressure.
 */
export function ChatInput({
  value,
  cursor,
  mask,
  placeholder = "",
  showCursor = true,
  focus = true,
  textColor,
}: ChatInputProps): React.ReactElement {
  const safeCursor = Math.max(0, Math.min(cursor, value.length));
  const displayValueMasked = mask ? mask.repeat(value.length) : value;

  const textProps = textColor ? { color: textColor as "white" } : {};

  let renderedValue: React.ReactNode = displayValueMasked;
  let renderedPlaceholder: React.ReactNode = placeholder ? (
    <Text
      {...textProps}
      dimColor={!textColor}
    >
      {placeholder}
    </Text>
  ) : null;

  if (showCursor && focus) {
    // Placeholder with cursor
    if (placeholder.length > 0 && displayValueMasked.length === 0) {
      renderedPlaceholder = (
        <Text {...textProps}>
          <Text inverse>{placeholder[0]}</Text>
          <Text
            {...textProps}
            dimColor={!textColor}
          >
            {placeholder.slice(1)}
          </Text>
        </Text>
      );
    } else if (displayValueMasked.length === 0) {
      renderedPlaceholder = (
        <Text
          {...textProps}
          inverse
        >
          {" "}
        </Text>
      );
    }

    // Value with cursor
    if (displayValueMasked.length > 0) {
      const before = displayValueMasked.slice(0, safeCursor);
      const cursorChar =
        safeCursor < displayValueMasked.length ? displayValueMasked[safeCursor] : " ";
      const after =
        safeCursor < displayValueMasked.length ? displayValueMasked.slice(safeCursor + 1) : "";

      renderedValue = (
        <Text {...textProps}>
          {before}
          <Text inverse>{cursorChar}</Text>
          {after}
        </Text>
      );
    } else {
      renderedValue = (
        <Text
          {...textProps}
          inverse
        >
          {" "}
        </Text>
      );
    }
  }

  // Render only the input line so the bordered box contains just this text.
  // Parent renders directory + shortcuts below the box so terminal selection
  // inside the box captures only the input text.
  return (
    <Box>
      <Text {...textProps}>
        {displayValueMasked.length > 0
          ? renderedValue
          : placeholder
            ? renderedPlaceholder
            : renderedValue}
      </Text>
    </Box>
  );
}
