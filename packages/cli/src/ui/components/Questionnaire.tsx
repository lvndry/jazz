import type { Suggestion } from "@jazz/core/interfaces/presentation";
import { Box, Text } from "ink";
import React, { useMemo } from "react";
import { TextInput } from "./TextInput";
import { getGlyphs } from "../glyphs";
import { useInputHandler, InputPriority, InputResults } from "../hooks/use-input-service";
import {
  binaryAnswerIndices,
  CUSTOM_ANSWER_LABEL,
  MAX_QUICK_PICK,
  questionKeys,
  questionPositionLabel,
} from "../models/question";
import { usePicker, type PickerChoice } from "../prompt-core";
import { THEME } from "../theme";

interface QuestionnaireProps {
  suggestions: readonly Suggestion[];
  allowMultiple?: boolean;
  /** Where this question sits in a set asked together; shown as `1 of 2`. */
  position?: { readonly index: number; readonly total: number } | undefined;
  onSubmit: (response: string) => void;
  onCancel?: () => void;
}

function toPickerChoice(suggestion: Suggestion): PickerChoice {
  return {
    label: suggestion.label ?? suggestion.value,
    value: suggestion.value,
    ...(suggestion.description === undefined ? {} : { description: suggestion.description }),
  };
}

/**
 * Suggested-responses picker. Selection, multi-select and custom-input state
 * come from the shared picker core; this component maps suggestions into core
 * choices, feeds `useInputHandler` actions into intents, and paints the view.
 * The inline custom text field keeps its own `TextInput` (which submits
 * directly) — the core only owns the suggestion list and selection.
 * See `prompt-core/picker-core.ts`.
 *
 * The words, the free-text row, the yes/no keys and the legend come from the shared
 * question model, so this reads and answers the same as the fullscreen overlay.
 */
export function Questionnaire({
  suggestions,
  allowMultiple = false,
  position,
  onSubmit,
  onCancel,
}: QuestionnaireProps): React.ReactElement {
  const choices = useMemo(() => suggestions.map(toPickerChoice), [suggestions]);
  // Every question the agent asks ends with a way to answer in your own words.
  const effectiveAllowCustom = true;
  const customOptionIndex = suggestions.length;
  const binary = binaryAnswerIndices(
    choices.map((choice) => choice.label),
    allowMultiple,
  );
  const keys = questionKeys({
    binary: binary !== undefined,
    multiple: allowMultiple,
    choiceCount: suggestions.length,
    skippable: true,
  });
  const positionLabel = questionPositionLabel(position);

  const picker = usePicker({
    type: "questionnaire",
    choices,
    allowMultiple,
    allowCustom: effectiveAllowCustom,
    onResolve: (resolution) => {
      if (resolution.kind === "single") {
        onSubmit(resolution.value);
      } else if (resolution.kind === "multi") {
        onSubmit(resolution.values.join(", "));
      }
    },
    onCancel,
  });

  const { view, state, dispatch } = picker;

  useInputHandler({
    id: "questionnaire-nav",
    priority: InputPriority.PROMPT,
    onInput: (action) => {
      if (action.type === "up") {
        dispatch({ kind: "move", delta: -1 });
        return InputResults.consumed();
      }
      if (action.type === "down") {
        dispatch({ kind: "move", delta: 1 });
        return InputResults.consumed();
      }
      if (action.type === "submit") {
        if (state.cursor === customOptionIndex && effectiveAllowCustom) {
          return InputResults.ignored();
        }
        dispatch({ kind: "submit" });
        return InputResults.consumed();
      }
      if (action.type === "escape") {
        if (onCancel) {
          onCancel();
          return InputResults.consumed();
        }
      }
      if (action.type === "char") {
        if (allowMultiple && action.char === " " && state.cursor < suggestions.length) {
          dispatch({ kind: "toggle" });
          return InputResults.consumed();
        }
        const isTyping = state.cursor === customOptionIndex && effectiveAllowCustom;
        if (!isTyping && binary !== undefined && (action.char === "y" || action.char === "n")) {
          const answer = suggestions[action.char === "y" ? binary.yes : binary.no];
          if (answer !== undefined) onSubmit(answer.value);
          return InputResults.consumed();
        }
        if (!isTyping && action.char >= "1" && action.char <= "9") {
          const index = parseInt(action.char, 10) - 1;
          if (index < Math.min(suggestions.length, MAX_QUICK_PICK)) {
            dispatch({ kind: "quickPick", index });
            if (!allowMultiple) dispatch({ kind: "submit" });
            return InputResults.consumed();
          }
        }
      }
      return InputResults.ignored();
    },
    deps: [state, suggestions, effectiveAllowCustom, allowMultiple, binary, onSubmit, onCancel],
  });

  const renderIndicator = (row: (typeof view.rows)[number]) => {
    if (allowMultiple) {
      return (
        <Text color={row.active ? THEME.selected : THEME.secondary}>
          {row.active ? `${getGlyphs().arrow} ` : "  "}
          <Text color={row.selected ? THEME.selected : THEME.muted}>
            {row.selected ? `[${getGlyphs().todoDone}]` : "[ ]"}
          </Text>
        </Text>
      );
    }
    return (
      <Text
        color={row.active ? THEME.selected : THEME.secondary}
        bold={row.active}
      >
        {row.active ? "› " : "  "}
      </Text>
    );
  };

  return (
    <Box flexDirection="column">
      {positionLabel === undefined ? null : <Text dimColor>{positionLabel}</Text>}
      {view.rows.map((row, i) => {
        const isFocused = i === view.cursor;
        return (
          <Box
            key={row.originalIndex}
            flexDirection="column"
          >
            <Box>
              {renderIndicator(row)}
              <Text color={isFocused ? THEME.selected : THEME.primary}> {i + 1}.</Text>
              <Text
                color={isFocused ? THEME.selected : THEME.secondary}
                bold={isFocused}
              >
                {" "}
                {row.label}
              </Text>
            </Box>
            {row.description ? (
              <Box paddingLeft={5}>
                <Text dimColor>{row.description}</Text>
              </Box>
            ) : null}
          </Box>
        );
      })}

      {effectiveAllowCustom && (
        <Box marginTop={suggestions.length > 0 ? 1 : 0}>
          <Box>
            <Text
              color={state.cursor === customOptionIndex ? THEME.selected : THEME.muted}
              bold={state.cursor === customOptionIndex}
            >
              {state.cursor === customOptionIndex ? "› " : "  "}
            </Text>
            {state.cursor === customOptionIndex ? (
              <TextInput
                inputId="questionnaire-inline-custom"
                onSubmit={(value) => {
                  if (value.trim()) onSubmit(value.trim());
                }}
              />
            ) : (
              <Text
                color={THEME.muted}
                italic
              >
                {CUSTOM_ANSWER_LABEL}
              </Text>
            )}
          </Box>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>{keys.map((entry) => `${entry.key} ${entry.label}`).join(" · ")}</Text>
      </Box>
    </Box>
  );
}
