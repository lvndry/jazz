import { Box, Text, useInput } from "ink";
import React, { useMemo } from "react";
import { getGlyphs } from "../glyphs";
import { PICKER_WINDOW_SIZE, pickerWindowStart } from "../picker-window";
import {
  originalValueFromPicker,
  toPickerChoices,
  usePicker,
  type PickerView,
} from "../prompt-core";
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
 * Searchable picker. Behaviour (filtering, ranking, cursor, resolution) comes
 * from the shared picker core; this component only translates ink keys into
 * intents and paints the derived view. See `prompt-core/picker-core.ts`.
 */
export function SearchSelect<T = unknown>({
  options,
  pageSize = PICKER_WINDOW_SIZE,
  placeholder = "Type to search...",
  onSelect,
  onCancel,
}: SearchSelectProps<T>): React.ReactElement {
  const choices = useMemo(() => toPickerChoices(options), [options]);
  const picker = usePicker({
    type: "search",
    choices,
    onResolve: (resolution) => {
      if (resolution.kind === "single") {
        const value = originalValueFromPicker(options, resolution.value);
        if (value !== undefined) onSelect(value);
      } else if (resolution.kind === "custom") {
        const value = originalValueFromPicker(options, resolution.value);
        if (value !== undefined) onSelect(value);
      }
    },
    onCancel,
  });

  const { view, state, dispatch } = picker;
  const query = state.query;

  useInput((input, key) => {
    if (key.escape) {
      onCancel?.();
      return;
    }
    if (key.upArrow) {
      dispatch({ kind: "move", delta: -1 });
      return;
    }
    if (key.downArrow) {
      dispatch({ kind: "move", delta: 1 });
      return;
    }
    if (key.return) {
      dispatch({ kind: "submit" });
      return;
    }
    if (key.backspace || key.delete) {
      dispatch({ kind: "setQuery", query: query.slice(0, -1) });
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      dispatch({ kind: "setQuery", query: query + input });
    }
  });

  const effectivePageSize = Math.max(1, Math.min(pageSize, view.rows.length || 1));
  const windowStart = pickerWindowStart(view.cursor, view.rows.length, effectivePageSize);
  const windowEndExclusive = Math.min(view.rows.length, windowStart + effectivePageSize);
  const hasMoreAbove = windowStart > 0;
  const hasMoreBelow = windowEndExclusive < view.rows.length;

  return (
    <Box flexDirection="column">
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

      <Box marginTop={1}>
        <Text dimColor>
          {view.filteredCount} of {view.totalCount} results
          {hasMoreAbove || hasMoreBelow ? " (↑/↓ to scroll)" : ""}
        </Text>
      </Box>

      {hasMoreAbove && <Text dimColor>↑ more</Text>}

      {view.rows.length === 0 ? (
        <Text dimColor>(No matching options)</Text>
      ) : (
        view.rows.slice(windowStart, windowEndExclusive).map((row) => (
          <PickerRowLine
            key={row.originalIndex}
            row={row}
            query={query}
          />
        ))
      )}

      {hasMoreBelow && <Text dimColor>↓ more</Text>}

      <Box marginTop={1}>
        <Text dimColor>Type to filter · ↑/↓ navigate · Enter select · Esc cancel</Text>
      </Box>
    </Box>
  );
}

function PickerRowLine({
  row,
  query,
}: {
  readonly row: PickerView["rows"][number];
  readonly query: string;
}): React.ReactElement {
  const queryLength = query.trim().length;
  const labelColor = row.active ? THEME.selected : THEME.secondary;

  return (
    <Box flexDirection="row">
      <Text
        color={THEME.primary}
        bold
      >
        {row.active ? `${G.rail} ` : "  "}
      </Text>
      {row.matchIndex >= 0 && queryLength > 0 ? (
        <Text
          color={labelColor}
          bold={row.active}
        >
          {row.label.slice(0, row.matchIndex)}
          <Text
            color={THEME.primary}
            bold
          >
            {row.label.slice(row.matchIndex, row.matchIndex + queryLength)}
          </Text>
          {row.label.slice(row.matchIndex + queryLength)}
        </Text>
      ) : (
        <Text
          color={labelColor}
          bold={row.active}
        >
          {row.label}
        </Text>
      )}
      {row.description ? <Text color={THEME.muted}>{`  ${row.description}`}</Text> : null}
    </Box>
  );
}
