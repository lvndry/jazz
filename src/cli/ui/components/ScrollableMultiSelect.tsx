import { Box, Text, useInput } from "ink";
import React, { useMemo } from "react";
import { getGlyphs } from "../glyphs";
import { pickerWindowStart } from "../picker-window";
import { originalValuesFromPicker, toPickerChoices, usePicker } from "../prompt-core";
import { THEME } from "../theme";
import type { Choice } from "../types";

const G = getGlyphs();

interface ScrollableMultiSelectProps<T = unknown> {
  readonly options: readonly Choice<T>[];
  readonly defaultSelected?: T | readonly T[];
  readonly pageSize?: number;
  readonly onSubmit: (selectedValues: readonly T[]) => void;
  readonly onCancel?: () => void;
}

function normalizeDefaultSelected<T>(defaultSelected: T | readonly T[] | undefined): readonly T[] {
  if (defaultSelected === undefined) return [];
  if (Array.isArray(defaultSelected)) return defaultSelected as readonly T[];
  return [defaultSelected as T];
}

/**
 * Multi-select checkbox list. Behaviour comes from the shared picker core;
 * this component translates ink keys into intents and paints the derived view.
 * See `prompt-core/picker-core.ts`.
 */
export function ScrollableMultiSelect<T = unknown>({
  options,
  defaultSelected,
  pageSize = 10,
  onSubmit,
  onCancel,
}: ScrollableMultiSelectProps<T>): React.ReactElement {
  const choices = useMemo(() => toPickerChoices(options), [options]);
  const defaultChecked = useMemo(() => {
    const values = new Set(normalizeDefaultSelected(defaultSelected).map(String));
    return choices
      .map((choice, index) => (values.has(choice.value) ? index : -1))
      .filter((i) => i >= 0);
  }, [choices, defaultSelected]);

  const picker = usePicker({
    type: "checkbox",
    choices,
    allowMultiple: true,
    defaultChecked,
    onResolve: (resolution) => {
      if (resolution.kind === "multi") {
        onSubmit(originalValuesFromPicker(options, resolution.values));
      }
    },
    onCancel,
  });

  const { view, dispatch } = picker;

  useInput((input, key) => {
    if (key.escape) {
      onCancel?.();
      return;
    }
    if (key.upArrow || input === "k") {
      dispatch({ kind: "move", delta: -1 });
      return;
    }
    if (key.downArrow || input === "j") {
      dispatch({ kind: "move", delta: 1 });
      return;
    }
    if (input === " ") {
      dispatch({ kind: "toggle" });
      return;
    }
    if (key.return) {
      dispatch({ kind: "submit" });
    }
  });

  const effectivePageSize = Math.max(1, Math.min(pageSize, view.rows.length || 1));
  const windowStart = pickerWindowStart(view.cursor, view.rows.length, effectivePageSize);
  const windowEndExclusive = Math.min(view.rows.length, windowStart + effectivePageSize);
  const hasMoreAbove = windowStart > 0;
  const hasMoreBelow = windowEndExclusive < view.rows.length;

  return (
    <Box flexDirection="column">
      {(hasMoreAbove || hasMoreBelow) && (
        <Text dimColor>
          List scrolls {hasMoreAbove ? "↑" : ""} {hasMoreBelow ? "↓" : ""} (use ↑/↓)
        </Text>
      )}

      {hasMoreAbove && <Text dimColor>↑ more</Text>}

      {view.rows.length === 0 ? (
        <Box flexDirection="column">
          <Text dimColor>(No options)</Text>
          <Text dimColor>Press Enter to submit.</Text>
        </Box>
      ) : (
        view.rows.slice(windowStart, windowEndExclusive).map((row) => (
          <Box key={row.originalIndex}>
            <Text
              color={THEME.primary}
              bold
            >
              {row.active ? G.rail : " "}
            </Text>
            <Text
              color={row.active ? THEME.selected : THEME.secondary}
              bold={row.active}
            >
              {" "}
              [{row.selected ? "x" : " "}] {row.label}
            </Text>
          </Box>
        ))
      )}

      {hasMoreBelow && <Text dimColor>↓ more</Text>}

      <Text dimColor>Space: toggle · Enter: submit</Text>
    </Box>
  );
}
