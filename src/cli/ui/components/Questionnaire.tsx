import { Box, Text } from "ink";
import React, { useState } from "react";
import type { Suggestion } from "@/core/interfaces/presentation";
import { THEME } from "../theme";
import { TextInput } from "./TextInput";
import { useInputHandler, InputPriority, InputResults } from "../hooks/use-input-service";


interface QuestionnaireProps {
  suggestions: readonly Suggestion[];
  allowCustom: boolean;
  allowMultiple?: boolean;
  onSubmit: (response: string) => void;
  onCancel?: () => void;
}

/**
 * Questionnaire component that displays suggested responses and an inline custom input.
 * Supports both single-select (radio) and multi-select (checkbox) modes.
 * The custom input is the last option and can be typed into directly when selected.
 * When there are no suggestions, only the custom text input is shown so the user is never blocked.
 */
export function Questionnaire({
  suggestions,
  allowCustom,
  allowMultiple = false,
  onSubmit,
  onCancel,
}: QuestionnaireProps): React.ReactElement {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [customValue] = useState("");

  // When no suggestions, always show custom input so the user can type (never blocked)
  const effectiveAllowCustom = allowCustom || suggestions.length === 0;
  const totalItems = effectiveAllowCustom ? suggestions.length + 1 : suggestions.length;
  const customOptionIndex = suggestions.length;

  useInputHandler({
    id: "questionnaire-nav",
    priority: InputPriority.PROMPT,
    onInput: (action) => {
      if (action.type === "up") {
        setSelectedIndex((i) => Math.max(0, i - 1));
        return InputResults.consumed();
      }
      if (action.type === "down") {
        setSelectedIndex((i) => Math.min(totalItems - 1, i + 1));
        return InputResults.consumed();
      }
      if (action.type === "submit") {
        if (allowMultiple) {
          // In multiselect mode, Enter submits all selected items
          if (selectedIndices.size > 0) {
            const selectedValues = Array.from(selectedIndices)
              .sort((a, b) => a - b)
              .map((i) => suggestions[i]?.value)
              .filter(Boolean) as string[];
            onSubmit(selectedValues.join(", "));
            return InputResults.consumed();
          }
          // If nothing selected, select the current item and submit
          if (selectedIndex < suggestions.length) {
            const suggestion = suggestions[selectedIndex];
            if (suggestion) {
              onSubmit(suggestion.value);
              return InputResults.consumed();
            }
          }
        } else {
          // Single-select mode: submit the current selection
          if (selectedIndex < suggestions.length) {
            const suggestion = suggestions[selectedIndex];
            if (suggestion) {
              onSubmit(suggestion.value);
              return InputResults.consumed();
            }
          }
        }
        // If on custom input, TextInput component handles the submit
        return InputResults.ignored();
      }
      if (action.type === "escape") {
        if (onCancel) {
          onCancel();
          return InputResults.consumed();
        }
      }
      if (action.type === "char") {
        // Space toggles selection in multiselect mode
        if (allowMultiple && action.char === " " && selectedIndex < suggestions.length) {
          setSelectedIndices((prev) => {
            const next = new Set(prev);
            if (next.has(selectedIndex)) {
              next.delete(selectedIndex);
            } else {
              next.add(selectedIndex);
            }
            return next;
          });
          return InputResults.consumed();
        }

        // Quick select by number key (only if not currently typing in the input field)
        const isTyping = selectedIndex === customOptionIndex && effectiveAllowCustom;
        if (!isTyping && action.char >= "1" && action.char <= "9") {
          const index = parseInt(action.char, 10) - 1;
          if (index < suggestions.length) {
            const suggestion = suggestions[index];
            if (suggestion) {
              if (allowMultiple) {
                // Toggle selection in multiselect mode
                setSelectedIndices((prev) => {
                  const next = new Set(prev);
                  if (next.has(index)) {
                    next.delete(index);
                  } else {
                    next.add(index);
                  }
                  return next;
                });
                setSelectedIndex(index);
              } else {
                onSubmit(suggestion.value);
              }
              return InputResults.consumed();
            }
          }
        }
      }
      return InputResults.ignored();
    },
    deps: [selectedIndex, selectedIndices, suggestions, effectiveAllowCustom, allowMultiple, onSubmit, onCancel],
  });

  const renderIndicator = (index: number) => {
    if (allowMultiple) {
      const isSelected = selectedIndices.has(index);
      const isFocused = index === selectedIndex;
      return (
        <Text color={isFocused ? THEME.selected : "white"}>
          {isFocused ? "› " : "  "}
          <Text color={isSelected ? THEME.selected : "gray"}>{isSelected ? "[✓]" : "[ ]"}</Text>
        </Text>
      );
    }
    return (
      <Text color={index === selectedIndex ? THEME.selected : "white"} bold={index === selectedIndex}>
        {index === selectedIndex ? "› " : "  "}
      </Text>
    );
  };

  return (
    <Box flexDirection="column">
      {/* Suggested responses */}
      {suggestions.map((suggestion, i) => {
        const label = suggestion.label ?? suggestion.value;
        const description = suggestion.description;
        const isFocused = i === selectedIndex;

        return (
          <Box key={i} flexDirection="column">
            <Box>
              {renderIndicator(i)}
              <Text color={isFocused ? THEME.selected : THEME.primary}> {i + 1}.</Text>
              <Text color={isFocused ? THEME.selected : "white"} bold={isFocused}> {label}</Text>
            </Box>
            {description && (
              <Box paddingLeft={5}>
                <Text dimColor>{description}</Text>
              </Box>
            )}
          </Box>
        );
      })}

      {/* Inline Custom input */}
      {effectiveAllowCustom && (
        <Box marginTop={suggestions.length > 0 ? 1 : 0}>
          <Box>
            <Text color={selectedIndex === customOptionIndex ? THEME.selected : "gray"} bold={selectedIndex === customOptionIndex}>
              {selectedIndex === customOptionIndex ? "› " : "  "}
            </Text>
            {selectedIndex === customOptionIndex ? (
              <TextInput
                inputId="questionnaire-inline-custom"
                defaultValue={customValue}
                onSubmit={(value) => {
                  if (value.trim()) {
                    onSubmit(value.trim());
                  }
                }}
              />
            ) : (
              <Text color="gray">Type your own response...</Text>
            )}
          </Box>
        </Box>
      )}

      {/* Keyboard hints */}
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

