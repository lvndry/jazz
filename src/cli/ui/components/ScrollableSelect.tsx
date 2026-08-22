import { Box, Text, useInput } from "ink";
import React, { useEffect, useState } from "react";
import { getGlyphs } from "../glyphs";
import { PICKER_WINDOW_SIZE, pickerWindowStart, wrapIndex } from "../picker-window";
import { THEME } from "../theme";
import type { Choice } from "../types";

const G = getGlyphs();

interface ScrollableSelectProps<T = unknown> {
  readonly options: readonly Choice<T>[];
  readonly pageSize?: number;
  readonly initialIndex?: number;
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
  pageSize = PICKER_WINDOW_SIZE,
  initialIndex = 0,
  onSelect,
  onCancel,
}: ScrollableSelectProps<T>): React.ReactElement {
  const effectivePageSize = Math.max(1, Math.min(pageSize, options.length || 1));

  const clampedInitialIndex = Math.max(0, Math.min(Math.max(0, options.length - 1), initialIndex));
  const [cursorIndex, setCursorIndex] = useState(clampedInitialIndex);
  const windowStart = pickerWindowStart(cursorIndex, options.length, effectivePageSize);

  const windowEndExclusive = Math.min(options.length, windowStart + effectivePageSize);
  const hasMoreAbove = windowStart > 0;
  const hasMoreBelow = windowEndExclusive < options.length;

  useEffect(() => {
    setCursorIndex(clampedInitialIndex);
  }, [options, clampedInitialIndex]);

  function findNextEnabledIndex(from: number, direction: 1 | -1): number {
    if (options.length === 0) return 0;
    let index = from;
    for (let step = 0; step < options.length; step += 1) {
      index = wrapIndex(index + direction, options.length);
      if (options[index]?.disabled !== true) return index;
    }
    return from;
  }

  function moveCursor(delta: number): void {
    const direction = delta > 0 ? 1 : -1;
    setCursorIndex(findNextEnabledIndex(cursorIndex, direction));
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
          <Text dimColor>{options.length} options (↑/↓ to scroll)</Text>
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
            <Text
              key={absoluteIndex}
              dimColor
            >
              {"  "}
              {choice.label}
            </Text>
          );
        }

        return (
          <Box key={absoluteIndex}>
            <Text
              color={THEME.primary}
              bold
            >
              {isActive ? `${G.rail} ` : "  "}
            </Text>
            <Text
              color={isActive ? THEME.selected : THEME.secondary}
              bold={isActive}
            >
              {choice.label}
            </Text>
          </Box>
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
