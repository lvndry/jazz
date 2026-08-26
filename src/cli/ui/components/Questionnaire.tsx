import { Box, Text } from "ink";
import React, { useMemo } from "react";
import type { Suggestion } from "@/core/interfaces/presentation";
import { THEME } from "../theme";
import { TextInput } from "./TextInput";
import { useInputHandler, InputPriority, InputResults } from "../hooks/use-input-service";
import { usePicker, type PickerChoice } from "../prompt-core";

interface QuestionnaireProps {
  suggestions: readonly Suggestion[];
  allowCustom: boolean;
  allowMultiple?: boolean;
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
 */
export function Questionnaire({
  suggestions,
  allowCustom,
  allowMultiple = false,
  onSubmit,
  onCancel,
}: QuestionnaireProps): React.ReactElement {
  const choices = useMemo(() => suggestions.map(toPickerChoice), [suggestions]);
  const effectiveAllowCustom = allowCustom || suggestions.length === 0;
  const customOptionIndex = suggestions.length;

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
        if (!isTyping && action.char >= "1" && action.char <= "9") {
          const index = parseInt(action.char, 10) - 1;
          if (index < suggestions.length) {
            dispatch({ kind: "quickPick", index });
            if (!allowMultiple) dispatch({ kind: "submit" });
            return InputResults.consumed();
          }
        }
      }
      return InputResults.ignored();
    },
    deps: [state, suggestions, effectiveAllowCustom, allowMultiple, onSubmit, onCancel],
  });

  const renderIndicator = (row: (typeof view.rows)[number]) => {
    if (allowMultiple) {
      return (
        <Text color={row.active ? THEME.selected : THEME.secondary}>
          {row.active ? "› " : "  "}
          <Text color={row.selected ? THEME.selected : "gray"}>{row.selected ? "[✓]" : "[ ]"}</Text>
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
              color={state.cursor === customOptionIndex ? THEME.selected : "gray"}
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
              <Text color={THEME.muted}>Type your own response...</Text>
            )}
          </Box>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          {allowMultiple
            ? "↑/↓ navigate • Space toggle • Enter submit • 1-9 toggle"
            : "↑/↓ navigate • Enter select • 1-9 quick pick"}
        </Text>
      </Box>
    </Box>
  );
}
