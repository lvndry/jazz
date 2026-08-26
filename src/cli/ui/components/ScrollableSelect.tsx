import { Box, Text, useInput } from "ink";
import React, { useMemo } from "react";
import { getGlyphs } from "../glyphs";
import { PICKER_WINDOW_SIZE, pickerWindowStart } from "../picker-window";
import { originalValueFromPicker, toPickerChoices, usePicker } from "../prompt-core";
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
 * Scrollable single-select (also used for `confirm`). Behaviour comes from the
 * shared picker core; this component translates ink keys into intents and
 * paints the derived view. See `prompt-core/picker-core.ts`.
 */
export function ScrollableSelect<T = unknown>({
  options,
  pageSize = PICKER_WINDOW_SIZE,
  initialIndex = 0,
  onSelect,
  onCancel,
}: ScrollableSelectProps<T>): React.ReactElement {
  const choices = useMemo(() => toPickerChoices(options), [options]);
  const picker = usePicker({
    type: "select",
    choices,
    initialCursor: initialIndex,
    onResolve: (resolution) => {
      if (resolution.kind === "single") {
        const value = originalValueFromPicker(options, resolution.value);
        if (value !== undefined) onSelect(value);
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
        <Box>
          <Text dimColor>{view.totalCount} options (↑/↓ to scroll)</Text>
        </Box>
      )}

      {hasMoreAbove && <Text dimColor>↑ more</Text>}

      {view.rows.length === 0 ? (
        <Text dimColor>(No options)</Text>
      ) : (
        view.rows.slice(windowStart, windowEndExclusive).map((row) => {
          if (row.disabled) {
            return (
              <Text
                key={row.originalIndex}
                dimColor
              >
                {"  "}
                {row.label}
              </Text>
            );
          }
          return (
            <Box key={row.originalIndex}>
              <Text
                color={THEME.primary}
                bold
              >
                {row.active ? `${G.rail} ` : "  "}
              </Text>
              <Text
                color={row.active ? THEME.selected : THEME.secondary}
                bold={row.active}
              >
                {row.label}
              </Text>
            </Box>
          );
        })
      )}

      {hasMoreBelow && <Text dimColor>↓ more</Text>}

      <Box marginTop={1}>
        <Text dimColor>↑/↓ navigate · Enter select · Esc cancel</Text>
      </Box>
    </Box>
  );
}
