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
 * Normalize line endings to \n. Pasted text may contain \r\n (Windows)
 * or bare \r (old Mac) line endings depending on the source and terminal.
 */
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * TextInput component that renders the current input value.
 *
 * Supports multi-line values (e.g. from pasted text). Long lines are
 * wrapped to the next terminal row to keep all content visible.
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
  const normalizedValue = normalizeLineEndings(value);
  const safeCursor = Math.max(0, Math.min(cursor, normalizedValue.length));
  const displayValue = mask ? mask.repeat(normalizedValue.length) : normalizedValue;

  const textProps = textColor ? { color: textColor as "white" } : {};
  const isActive = showCursor && focus;

  // Empty value - show placeholder or cursor
  if (displayValue.length === 0) {
    if (isActive) {
      if (placeholder.length > 0) {
        return (
          <Box>
            <Text {...textProps}>
              <Text inverse>{placeholder[0]}</Text>
              <Text
                {...textProps}
                dimColor={!textColor}
              >
                {placeholder.slice(1)}
              </Text>
            </Text>
          </Box>
        );
      }
      return (
        <Box>
          <Text
            {...textProps}
            inverse
          >
            {" "}
          </Text>
        </Box>
      );
    }
    return (
      <Box>
        {placeholder ? (
          <Text
            {...textProps}
            dimColor={!textColor}
          >
            {placeholder}
          </Text>
        ) : null}
      </Box>
    );
  }

  // Single-line value - wrap long lines to the next terminal row
  if (!displayValue.includes("\n")) {
    return (
      <Box>
        <Text
          {...textProps}
          wrap="wrap"
        >
          {renderWithCursor(displayValue, isActive, safeCursor)}
        </Text>
      </Box>
    );
  }

  // Multi-line value - render each line separately, truncated
  const lines = displayValue.split("\n");

  // Find which line the cursor is on
  let charCount = 0;
  let cursorLine = 0;
  let cursorOffsetInLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineLen = lines[i]!.length;
    if (safeCursor <= charCount + lineLen) {
      cursorLine = i;
      cursorOffsetInLine = safeCursor - charCount;
      break;
    }
    charCount += lineLen + 1; // +1 for the \n
  }

  // Cap visible lines to avoid flooding the terminal
  const MAX_VISIBLE_LINES = 15;
  const totalLines = lines.length;
  let startLine = 0;
  let endLine = totalLines;

  if (totalLines > MAX_VISIBLE_LINES) {
    // Scroll to keep cursor line visible
    const halfWindow = Math.floor(MAX_VISIBLE_LINES / 2);
    startLine = Math.max(0, cursorLine - halfWindow);
    endLine = startLine + MAX_VISIBLE_LINES;
    if (endLine > totalLines) {
      endLine = totalLines;
      startLine = Math.max(0, endLine - MAX_VISIBLE_LINES);
    }
  }

  const visibleLines = lines.slice(startLine, endLine);

  return (
    <Box flexDirection="column">
      {startLine > 0 && (
        <Box>
          <Text dimColor>
            {" "}
            ({startLine} more line{startLine > 1 ? "s" : ""} above)
          </Text>
        </Box>
      )}
      {visibleLines.map((line, i) => {
        const globalLineIdx = startLine + i;
        const hasCursor = isActive && globalLineIdx === cursorLine;
        const displayLine = line.length === 0 && !hasCursor ? " " : line;

        return (
          <Box key={globalLineIdx}>
            <Text
              {...textProps}
              wrap="wrap"
            >
              {hasCursor ? renderWithCursor(displayLine, true, cursorOffsetInLine) : displayLine}
            </Text>
          </Box>
        );
      })}
      {endLine < totalLines && (
        <Box>
          <Text dimColor>
            {" "}
            ({totalLines - endLine} more line{totalLines - endLine > 1 ? "s" : ""} below)
          </Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * Render text content with an inverse-video cursor at the given offset.
 * Returns React children suitable for placement inside a <Text> element.
 */
function renderWithCursor(
  text: string,
  showCursor: boolean,
  cursorOffset: number,
): React.ReactNode {
  if (!showCursor) {
    return text;
  }

  const safeCursor = Math.max(0, Math.min(cursorOffset, text.length));
  const before = text.slice(0, safeCursor);
  const cursorChar = safeCursor < text.length ? text[safeCursor] : " ";
  const after = safeCursor < text.length ? text.slice(safeCursor + 1) : "";

  return (
    <>
      {before}
      <Text inverse>{cursorChar}</Text>
      {after}
    </>
  );
}
