import { Box, Text, useInput } from "ink";
import React, { useEffect, useMemo, useState } from "react";

import type { Choice } from "./types";

interface ScrollableMultiSelectProps<T = unknown> {
  readonly options: readonly Choice<T>[];
  readonly defaultSelected?: T | readonly T[];
  readonly pageSize?: number;
  readonly onSubmit: (selectedValues: readonly T[]) => void;
}

function normalizeDefaultSelected<T>(defaultSelected: T | readonly T[] | undefined): readonly T[] {
  if (defaultSelected === undefined) return [];
  if (Array.isArray(defaultSelected)) return defaultSelected as readonly T[];
  return [defaultSelected as T];
}

function buildDefaultSelectedIndexSet<T>(
  options: readonly Choice<T>[],
  defaultSelected: readonly T[],
): ReadonlySet<number> {
  if (defaultSelected.length === 0 || options.length === 0) return new Set<number>();

  const selected = new Set<number>();
  for (let i = 0; i < options.length; i++) {
    const value = options[i]!.value;
    if (defaultSelected.includes(value)) selected.add(i);
  }
  return selected;
}

export function ScrollableMultiSelect<T = unknown>({
  options,
  defaultSelected,
  pageSize = 10,
  onSubmit,
}: ScrollableMultiSelectProps<T>): React.ReactElement {
  const normalizedDefaultSelected = useMemo(
    () => normalizeDefaultSelected(defaultSelected),
    [defaultSelected],
  );

  const [cursorIndex, setCursorIndex] = useState(0);
  const [windowStart, setWindowStart] = useState(0);
  const [selectedIndexes, setSelectedIndexes] = useState<ReadonlySet<number>>(() =>
    buildDefaultSelectedIndexSet(options, normalizedDefaultSelected),
  );

  const effectivePageSize = Math.max(1, Math.min(pageSize, options.length || 1));
  const windowEndExclusive = Math.min(options.length, windowStart + effectivePageSize);
  const hasMoreAbove = windowStart > 0;
  const hasMoreBelow = windowEndExclusive < options.length;

  // React can keep this component mounted between prompts; ensure state resets.
  useEffect(() => {
    setCursorIndex(0);
    setWindowStart(0);
    setSelectedIndexes(buildDefaultSelectedIndexSet(options, normalizedDefaultSelected));
  }, [options, normalizedDefaultSelected]);

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

  function moveCursor(delta: number): void {
    const nextCursor = clampCursor(cursorIndex + delta);
    setCursorIndex(nextCursor);
    ensureCursorVisible(nextCursor);
  }

  function toggleSelected(index: number): void {
    setSelectedIndexes((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function submit(): void {
    const selected = Array.from(selectedIndexes).sort((a, b) => a - b);
    const values: T[] = [];
    for (const idx of selected) {
      const choice = options[idx];
      if (choice) values.push(choice.value);
    }
    onSubmit(values);
  }

  useInput((input, key) => {
    if (key.upArrow || input === "k") {
      moveCursor(-1);
      return;
    }

    if (key.downArrow || input === "j") {
      moveCursor(1);
      return;
    }

    if (input === " ") {
      if (options.length > 0) toggleSelected(cursorIndex);
      return;
    }

    if (key.return) {
      submit();
    }
  });

  if (options.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>(No options)</Text>
        <Text dimColor>Press Enter to submit.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {(hasMoreAbove || hasMoreBelow) && (
        <Text dimColor>
          List scrolls {hasMoreAbove ? "↑" : ""} {hasMoreBelow ? "↓" : ""} (use ↑/↓)
        </Text>
      )}

      {hasMoreAbove && <Text dimColor>↑ more</Text>}

      {options.slice(windowStart, windowEndExclusive).map((choice, localIndex) => {
        const absoluteIndex = windowStart + localIndex;
        const isActive = absoluteIndex === cursorIndex;
        const isSelected = selectedIndexes.has(absoluteIndex);

        return (
          <Text
            key={absoluteIndex}
            {...(isActive ? { color: "green" as const, bold: true as const } : {})}
          >
            {isActive ? "›" : " "} [{isSelected ? "x" : " "}] {choice.label}
          </Text>
        );
      })}

      {hasMoreBelow && <Text dimColor>↓ more</Text>}

      <Text dimColor>Space: toggle · Enter: submit</Text>
    </Box>
  );
}

