import { Box, Text } from "ink";
import React, { useState } from "react";
import type { Suggestion } from "@/core/interfaces/presentation";
import { TextInput } from "./TextInput";
import { useInputHandler, InputPriority, InputResults } from "../hooks/use-input-service";


interface QuestionnaireProps {
  suggestions: readonly (string | Suggestion)[];
  allowCustom: boolean;
  onSubmit: (response: string) => void;
  onCancel?: () => void;
}

/**
 * Questionnaire component that displays suggested responses and an inline custom input.
 * The custom input is the last option and can be typed into directly when selected.
 */
export function Questionnaire({
  suggestions,
  allowCustom,
  onSubmit,
  onCancel,
}: QuestionnaireProps): React.ReactElement {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [customValue] = useState("");

  const totalItems = allowCustom ? suggestions.length + 1 : suggestions.length;
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
        if (selectedIndex < suggestions.length) {
          const suggestion = suggestions[selectedIndex];
          if (suggestion) {
            const value = typeof suggestion === "string" ? suggestion : suggestion.value;
            onSubmit(value);
            return InputResults.consumed();
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
        // Quick select by number key (only if not currently typing in the input field)
        const isTyping = selectedIndex === customOptionIndex && allowCustom;
        if (!isTyping && action.char >= "1" && action.char <= "9") {
          const index = parseInt(action.char, 10) - 1;
          if (index < suggestions.length) {
            const suggestion = suggestions[index];
            if (suggestion) {
              const value = typeof suggestion === "string" ? suggestion : suggestion.value;
              onSubmit(value);
              return InputResults.consumed();
            }
          }
        }
      }
      return InputResults.ignored();
    },
    deps: [selectedIndex, suggestions, allowCustom, onSubmit, onCancel],
  });

  return (
    <Box flexDirection="column">
      {/* Suggested responses */}
      {suggestions.map((suggestion, i) => {
        const isString = typeof suggestion === "string";
        const label = isString ? suggestion : (suggestion.label ?? suggestion.value);
        const description = isString ? undefined : suggestion.description;

        return (
          <Box key={i} flexDirection="column">
            <Box>
              <Text color={i === selectedIndex ? "green" : "white"} bold={i === selectedIndex}>
                {i === selectedIndex ? "› " : "  "}
                <Text color={i === selectedIndex ? "green" : "cyan"}>{i + 1}.</Text> {label}
              </Text>
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
      {allowCustom && (
        <Box marginTop={suggestions.length > 0 ? 1 : 0}>
          <Box>
            <Text color={selectedIndex === customOptionIndex ? "green" : "gray"} bold={selectedIndex === customOptionIndex}>
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
        <Text dimColor>↑/↓ navigate • Enter select • 1-9 quick pick</Text>
      </Box>
    </Box>
  );
}

