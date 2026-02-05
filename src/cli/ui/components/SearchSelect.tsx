import { Box, Text, useInput } from "ink";
import React, { useEffect, useMemo, useState } from "react";
import type { Choice } from "../types";

interface SearchSelectProps<T = unknown> {
  readonly options: readonly Choice<T>[];
  readonly pageSize?: number;
  readonly onSelect: (value: T) => void;
  readonly onCancel?: () => void;
}

/**
 * SearchSelect - a searchable select component with filtering and pagination.
 * Type to filter options, use arrow keys to navigate, Enter to select, Escape to cancel.
 */
export function SearchSelect<T = unknown>({
  options,
  pageSize = 10,
  onSelect,
  onCancel,
}: SearchSelectProps<T>): React.ReactElement {
  const [query, setQuery] = useState("");
  const [cursorIndex, setCursorIndex] = useState(0);
  const [windowStart, setWindowStart] = useState(0);

  // Filter options based on query (case-insensitive)
  const filteredOptions = useMemo(() => {
    if (!query.trim()) return options;
    const lowerQuery = query.toLowerCase();
    return options.filter((opt) => opt.label.toLowerCase().includes(lowerQuery));
  }, [options, query]);

  const effectivePageSize = Math.max(1, Math.min(pageSize, filteredOptions.length || 1));
  const windowEndExclusive = Math.min(filteredOptions.length, windowStart + effectivePageSize);
  const hasMoreAbove = windowStart > 0;
  const hasMoreBelow = windowEndExclusive < filteredOptions.length;

  // Reset cursor and window when query changes
  useEffect(() => {
    setCursorIndex(0);
    setWindowStart(0);
  }, [query]);

  // Reset state when options change (new prompt)
  useEffect(() => {
    setQuery("");
    setCursorIndex(0);
    setWindowStart(0);
  }, [options]);

  function clampCursor(nextIndex: number): number {
    if (filteredOptions.length === 0) return 0;
    return Math.max(0, Math.min(filteredOptions.length - 1, nextIndex));
  }

  function ensureCursorVisible(nextCursor: number): void {
    if (filteredOptions.length <= effectivePageSize) {
      setWindowStart(0);
      return;
    }

    if (nextCursor < windowStart) {
      setWindowStart(nextCursor);
      return;
    }

    const endInclusive = windowStart + effectivePageSize - 1;
    if (nextCursor > endInclusive) {
      setWindowStart(Math.max(0, nextCursor - (effectivePageSize - 1)));
    }
  }

  function moveCursor(delta: number): void {
    const nextCursor = clampCursor(cursorIndex + delta);
    setCursorIndex(nextCursor);
    ensureCursorVisible(nextCursor);
  }

  function submit(): void {
    const selected = filteredOptions[cursorIndex];
    if (selected) {
      onSelect(selected.value);
    }
  }

  useInput((input, key) => {
    // Handle escape for cancellation
    if (key.escape) {
      onCancel?.();
      return;
    }

    // Navigation
    if (key.upArrow) {
      moveCursor(-1);
      return;
    }

    if (key.downArrow) {
      moveCursor(1);
      return;
    }

    // Selection
    if (key.return) {
      submit();
      return;
    }

    // Backspace handling
    if (key.backspace || key.delete) {
      setQuery((prev) => prev.slice(0, -1));
      return;
    }

    // Text input - only printable characters
    if (input && !key.ctrl && !key.meta) {
      setQuery((prev) => prev + input);
    }
  });

  return (
    <Box flexDirection="column">
      {/* Search input */}
      <Box>
        <Text color="gray">Search: </Text>
        <Text color="cyan">{query}</Text>
        <Text color="gray">│</Text>
      </Box>

      {/* Results count */}
      <Box marginTop={1}>
        <Text dimColor>
          {filteredOptions.length} of {options.length} results
          {hasMoreAbove || hasMoreBelow ? " (↑/↓ to scroll)" : ""}
        </Text>
      </Box>

      {/* Scroll indicator - top */}
      {hasMoreAbove && <Text dimColor>↑ more</Text>}

      {/* Options list */}
      {filteredOptions.length === 0 ? (
        <Text dimColor>(No matching options)</Text>
      ) : (
        filteredOptions.slice(windowStart, windowEndExclusive).map((choice, localIndex) => {
          const absoluteIndex = windowStart + localIndex;
          const isActive = absoluteIndex === cursorIndex;

          return (
            <Text
              key={absoluteIndex}
              {...(isActive ? { color: "green" as const, bold: true as const } : {})}
            >
              {isActive ? "> " : "  "}{choice.label}
            </Text>
          );
        })
      )}

      {/* Scroll indicator - bottom */}
      {hasMoreBelow && <Text dimColor>↓ more</Text>}

      {/* Help text */}
      <Box marginTop={1}>
        <Text dimColor>Type to filter · ↑/↓ navigate · Enter select · Esc cancel</Text>
      </Box>
    </Box>
  );
}
