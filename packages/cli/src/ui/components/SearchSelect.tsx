import type { ChoicePreviewLine } from "@jazz/core/interfaces/terminal";
import type { Effect } from "effect";
import { Box, Text, useInput } from "ink";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChoiceMeta } from "./PromptParts";
import { getGlyphs } from "../glyphs";
import { useTextInput } from "../hooks/use-input-service";
import {
  INITIAL_CHOICE_REMOVAL,
  pendingRemovalHints,
  reduceChoiceRemoval,
  REMOVAL_HINT,
  removalError,
  runRemoval,
  withoutRemoved,
  type ChoiceRemovalIntent,
  originalValueFromPicker,
  toPickerChoices,
  TYPED_ANSWER_DESCRIPTION,
  usePicker,
  type PickerView,
} from "../prompt-core";
import { PICKER_WINDOW_SIZE, pickerWindowStart } from "../text/picker-window";
import { THEME } from "../theme";
import type { Choice } from "../types";

interface SearchSelectProps<T = unknown> {
  readonly options: readonly Choice<T>[];
  readonly pageSize?: number;
  readonly placeholder?: string;
  readonly onSelect: (value: T) => void;
  /** When set, the typed filter is offered as its own answer and submitting it calls this. */
  readonly onTypedAnswer?: ((text: string) => void) | undefined;
  readonly onCancel?: () => void;
  /** Where the cursor starts, as an index into `options`. */
  readonly initialIndex?: number;
  /** When set, ctrl+d deletes the highlighted choice once confirmed; see `choice-removal.ts`. */
  readonly remove?: ((value: T) => Effect.Effect<void, Error>) | undefined;
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
  onTypedAnswer,
  onCancel,
  initialIndex = 0,
  remove,
}: SearchSelectProps<T>): React.ReactElement {
  const [removal, setRemoval] = useState(INITIAL_CHOICE_REMOVAL);
  const dispatchRemoval = useCallback((intent: ChoiceRemovalIntent) => {
    setRemoval((current) => reduceChoiceRemoval(current, intent));
  }, []);
  const visibleOptions = useMemo(() => withoutRemoved(options, removal), [options, removal]);
  const choices = useMemo(() => toPickerChoices(visibleOptions), [visibleOptions]);
  const picker = usePicker({
    type: "search",
    choices,
    initialCursor: initialIndex,
    allowCustom: onTypedAnswer !== undefined,
    onResolve: (resolution) => {
      if (resolution.kind === "single") {
        const value = originalValueFromPicker(visibleOptions, resolution.value);
        if (value !== undefined) onSelect(value);
      } else if (resolution.kind === "custom") {
        onTypedAnswer?.(resolution.value);
      }
    },
    onCancel,
  });

  const { view, state, dispatch } = picker;

  const shownChoices = useRef(choices);
  useEffect(() => {
    if (shownChoices.current !== choices) {
      shownChoices.current = choices;
      dispatch({ kind: "setChoices", choices });
    }
  }, [choices, dispatch]);

  const pending = removal.status;
  const startRemoval = (): void => {
    if (remove === undefined || pending.phase !== "confirming") {
      return;
    }
    dispatchRemoval({ kind: "start" });
    void runRemoval(remove as (value: unknown) => Effect.Effect<void, Error>, pending.value).then(
      dispatchRemoval,
    );
  };

  const {
    value: query,
    cursor: queryCursor,
    setValue: setQueryValue,
  } = useTextInput({
    id: "search-select-query",
    isActive: pending.phase === "idle",
    onSubmit: () => dispatch({ kind: "submit" }),
  });

  // The text-input store is keyed by id and persists across mounts, so a
  // freshly opened search picker must clear out whatever a previous one left.
  useEffect(() => {
    setQueryValue("", 0);
  }, []);

  useEffect(() => {
    if (query !== state.query) {
      dispatch({ kind: "setQuery", query });
    }
  }, [query, state.query, dispatch]);

  useInput((input, key) => {
    if (pending.phase === "confirming") {
      if (key.return) {
        startRemoval();
      } else if (key.escape) {
        dispatchRemoval({ kind: "keep" });
      }
      return;
    }
    if (pending.phase === "removing") {
      return;
    }
    if (remove !== undefined && key.ctrl && input === "d") {
      const row = view.rows[view.cursor];
      const choice = row === undefined ? undefined : choices[row.originalIndex];
      if (row !== undefined && choice !== undefined && !row.disabled) {
        dispatchRemoval({
          kind: "ask",
          value: originalValueFromPicker(visibleOptions, choice.value),
          label: row.label,
        });
      }
      return;
    }
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
  });

  const typedAnswer = view.typedAnswer;
  const effectivePageSize = Math.max(1, Math.min(pageSize, view.rows.length || 1));
  const windowStart = pickerWindowStart(
    Math.min(view.cursor, Math.max(0, view.rows.length - 1)),
    view.rows.length,
    effectivePageSize,
  );
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
            <Text inverse> </Text>
            {placeholder}
          </Text>
        ) : (
          <Text color={THEME.primary}>
            {query.slice(0, queryCursor)}
            <Text inverse>{queryCursor < query.length ? query[queryCursor] : " "}</Text>
            {queryCursor < query.length ? query.slice(queryCursor + 1) : ""}
          </Text>
        )}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          {view.filteredCount} of {view.totalCount} results
          {hasMoreAbove || hasMoreBelow ? " (↑/↓ to scroll)" : ""}
        </Text>
      </Box>

      {hasMoreAbove && <Text dimColor>↑ more</Text>}

      {view.rows.length === 0 && typedAnswer === undefined ? (
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

      {typedAnswer === undefined ? null : (
        <Box flexDirection="row">
          <Text
            color={THEME.primary}
            bold
          >
            {typedAnswer.active ? `${getGlyphs().rail} ` : "  "}
          </Text>
          <Text
            color={typedAnswer.active ? THEME.selected : THEME.secondary}
            bold={typedAnswer.active}
          >
            {typedAnswer.text}
          </Text>
          <Text color={THEME.muted}>{`  ${TYPED_ANSWER_DESCRIPTION}`}</Text>
        </Box>
      )}

      {removalError(removal) === undefined ? null : (
        <Box marginTop={1}>
          <Text color={THEME.warning}>{removalError(removal)}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        {pendingRemovalHints(removal) === undefined ? (
          <Text dimColor>
            Type to filter · ↑/↓ navigate · Enter select
            {remove === undefined ? "" : ` · ${REMOVAL_HINT.key} ${REMOVAL_HINT.label}`} · Esc
            cancel
          </Text>
        ) : (
          <Text color={THEME.warning}>
            {(pendingRemovalHints(removal) ?? [])
              .map((hint) => (hint.key.length === 0 ? hint.label : `${hint.key} ${hint.label}`))
              .join(" · ")}
          </Text>
        )}
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
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text
          color={THEME.primary}
          bold
        >
          {row.active ? `${getGlyphs().rail} ` : "  "}
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
        <ChoiceMeta
          description={row.description}
          tag={row.tag}
          tagTone={row.tagTone}
        />
      </Box>
      {row.active && row.preview !== undefined ? <PickerRowPreview lines={row.preview} /> : null}
    </Box>
  );
}

/** The active row's preview, indented beneath its label so it reads as belonging to it. */
function PickerRowPreview({
  lines,
}: {
  readonly lines: readonly ChoicePreviewLine[];
}): React.ReactElement {
  return (
    <Box flexDirection="column">
      {lines.map((line, lineIndex) => (
        <Box
          key={String(lineIndex)}
          flexDirection="row"
        >
          <Text>{"    "}</Text>
          <Text>
            {line.map((span, spanIndex) => (
              <Text
                key={String(spanIndex)}
                color={span.fg ?? THEME.muted}
                bold={span.bold === true}
              >
                {span.text}
              </Text>
            ))}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
