import { Box, Text, useInput } from "ink";
import React, { useEffect, useState } from "react";
import type { Choice } from "../types";

interface ScrollableSelectProps<T = unknown> {
  readonly options: readonly Choice<T>[];
  readonly pageSize?: number;
  readonly onSelect: (value: T) => void;
  readonly onCancel?: () => void;
}

/**
 * ScrollableSelect - a scrollable select component with pagination.
 * Uses arrow keys to navigate, Enter to select, Escape to cancel.
 * Shows 10 items at a time with scroll indicators.
 */
export function ScrollableSelect<T = unknown>({
  options,
  pageSize = 10,
  onSelect,
  onCancel,
}: ScrollableSelectProps<T>): React.ReactElement {
  const [cursorIndex, setCursorIndex] = useState(0);
  const [windowStart, setWindowStart] = useState(0);

  const effectivePageSize = Math.max(1, Math.min(pageSize, options.length || 1));
  const windowEndExclusive = Math.min(options.length, windowStart + effectivePageSize);
  const hasMoreAbove = windowStart > 0;
  const hasMoreBelow = windowEndExclusive < options.length;

  // Reset state when options change (new prompt)
  useEffect(() => {
    setCursorIndex(0);
    setWindowStart(0);
  }, [options]);

  function clampCursor(nextIndex: number): number {
    if (options.length === 0) return 0;
    return Math.max(0, Math.min(options.length - 1, nextIndex));
  }

  function ensureCursorVisible(nextCursor: number): void {
    if (options.length <= effectivePageSize) {
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

  function findNextEnabledIndex(from: number, direction: 1 | -1): number {
    let index = from;
    const maxIterations = options.length;
    let iterations = 0;
    while (iterations < maxIterations) {
      index = clampCursor(index + direction);
      const item = options[index];
      if (!item?.disabled) return index;
      // If we've wrapped or hit boundary without finding enabled, stop
      if (index === 0 && direction === -1) break;
      if (index === options.length - 1 && direction === 1) break;
      iterations++;
    }
    // Fallback: stay at current position if all disabled
    return from;
  }

  function moveCursor(delta: number): void {
    const direction = delta > 0 ? 1 : -1;
    const nextCursor = findNextEnabledIndex(cursorIndex, direction);
    setCursorIndex(nextCursor);
    ensureCursorVisible(nextCursor);
  }

  function submit(): void {
    const selected = options[cursorIndex];
    if (selected && !selected.disabled) {
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
    if (key.upArrow || input === "k") {
      moveCursor(-1);
      return;
    }

    if (key.downArrow || input === "j") {
      moveCursor(1);
      return;
    }

    // Selection
    if (key.return) {
      submit();
    }
  });

  if (options.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>(No options)</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {/* Results count */}
      {(hasMoreAbove || hasMoreBelow) && (
        <Box>
          <Text dimColor>
            {options.length} options (↑/↓ to scroll)
          </Text>
        </Box>
      )}

      {/* Scroll indicator - top */}
      {hasMoreAbove && <Text dimColor>↑ more</Text>}

      {/* Options list */}
      {options.slice(windowStart, windowEndExclusive).map((choice, localIndex) => {
        const absoluteIndex = windowStart + localIndex;
        const isActive = absoluteIndex === cursorIndex;
        const isDisabled = choice.disabled ?? false;

        // Disabled items: dimmed, cannot be selected
        if (isDisabled) {
          return (
            <Text key={absoluteIndex} dimColor>
              {"  "}{choice.label}
            </Text>
          );
        }

        return (
          <Text
            key={absoluteIndex}
            {...(isActive ? { color: "green" as const, bold: true as const } : {})}
          >
            {isActive ? "> " : "  "}{choice.label}
          </Text>
        );
      })}

      {/* Scroll indicator - bottom */}
      {hasMoreBelow && <Text dimColor>↓ more</Text>}

      {/* Help text */}
      <Box marginTop={1}>
        <Text dimColor>↑/↓ navigate · Enter select · Esc cancel</Text>
      </Box>
    </Box>
  );
}
