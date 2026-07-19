import { Box, Text, useInput } from "ink";
import React, { useEffect, useMemo, useState } from "react";
import { getGlyphs } from "../glyphs";
import { THEME } from "../theme";
import type { Choice } from "../types";

const G = getGlyphs();

interface SearchSelectProps<T = unknown> {
  readonly options: readonly Choice<T>[];
  readonly pageSize?: number;
  readonly placeholder?: string;
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
  placeholder = "Type to search...",
  onSelect,
  onCancel,
}: SearchSelectProps<T>): React.ReactElement {
  const [query, setQuery] = useState("");
  const [cursorIndex, setCursorIndex] = useState(0);
  const [windowStart, setWindowStart] = useState(0);

  // Filter + rank from the first character (case-insensitive). Plain
  // substring filtering alone barely narrows short queries — every label
  // contains most letters — so matches are ranked: label-prefix first, then
  // word-prefix (after space/dash/slash), then anywhere. The match position
  // is kept so the render can highlight it, making one-character filtering
  // visibly do something.
  const filteredOptions = useMemo(() => {
    const lowerQuery = query.trim().toLowerCase();
    if (!lowerQuery) {
      return options.map((option) => ({ option, matchIndex: -1 }));
    }
    const WORD_BOUNDARY = new Set([" ", "-", "_", "/", ".", "("]);
    const scored: { option: Choice<T>; matchIndex: number; rank: number }[] = [];
    for (const option of options) {
      const lowerLabel = option.label.toLowerCase();
      const matchIndex = lowerLabel.indexOf(lowerQuery);
      if (matchIndex === -1) continue;
      const rank =
        matchIndex === 0 ? 0 : WORD_BOUNDARY.has(option.label[matchIndex - 1] ?? "") ? 1 : 2;
      scored.push({ option, matchIndex, rank });
    }
    scored.sort((a, b) => a.rank - b.rank || a.matchIndex - b.matchIndex);
    return scored.map(({ option, matchIndex }) => ({ option, matchIndex }));
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
      onSelect(selected.option.value);
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
        <Text color={THEME.muted}>Search: </Text>
        {query.length === 0 ? (
          <Text
            color={THEME.muted}
            dimColor
          >
            <Text inverse>{placeholder[0] || " "}</Text>
            {placeholder.slice(1)}
          </Text>
        ) : (
          <>
            <Text color={THEME.primary}>{query}</Text>
            <Text inverse> </Text>
          </>
        )}
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
        filteredOptions.slice(windowStart, windowEndExclusive).map((entry, localIndex) => {
          const absoluteIndex = windowStart + localIndex;
          const isActive = absoluteIndex === cursorIndex;
          const { option, matchIndex } = entry;
          const queryLength = query.trim().length;
          const labelColor = isActive ? THEME.selected : THEME.secondary;

          return (
            <Box key={absoluteIndex}>
              <Text
                color={THEME.primary}
                bold
              >
                {isActive ? `${G.rail} ` : "  "}
              </Text>
              {matchIndex >= 0 && queryLength > 0 ? (
                <Text
                  color={labelColor}
                  bold={isActive}
                >
                  {option.label.slice(0, matchIndex)}
                  <Text
                    color={THEME.primary}
                    bold
                  >
                    {option.label.slice(matchIndex, matchIndex + queryLength)}
                  </Text>
                  {option.label.slice(matchIndex + queryLength)}
                </Text>
              ) : (
                <Text
                  color={labelColor}
                  bold={isActive}
                >
                  {option.label}
                </Text>
              )}
            </Box>
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
