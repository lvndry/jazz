import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { IndicatorComponent, ItemComponent } from "./ItemComponents";
import { LineInput } from "./LineInput";
import { ScrollableMultiSelect } from "./ScrollableMultiSelect";
import type { PromptState } from "./types";

/**
 * Prompt displays user input prompts with a minimal header design.
 * Uses spacing and color instead of box borders for copy-friendly terminal output.
 */
function PromptComponent({ prompt }: { prompt: PromptState; }): React.ReactElement {
  const [value, setValue] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  // Use refs to avoid recreating callbacks on every render
  const promptRef = useRef(prompt);
  const validationErrorRef = useRef(validationError);
  promptRef.current = prompt;
  validationErrorRef.current = validationError;

  useEffect(() => {
    // React can batch `setPrompt(null)` + `setPrompt(nextPrompt)`, so this component
    // may not unmount between prompts. Ensure the input is reset for each new prompt.
    const rawDefaultValue = prompt.options?.["defaultValue"];
    const defaultValue =
      prompt.type === "text" && typeof rawDefaultValue === "string"
        ? rawDefaultValue
        : "";

    setValue(defaultValue);
    setValidationError(null);
  }, [prompt]);

  // Stable callback - doesn't change between renders
  const handleSubmit = useCallback((val: string): void => {
    const currentPrompt = promptRef.current;
    // Check if validation function exists
    const validate = currentPrompt.options?.["validate"];
    if (
      validate !== undefined &&
      validate !== null &&
      typeof validate === "function"
    ) {
      // Type guard: validate is a function that takes string and returns boolean | string
      const validationFn = validate as (input: string) => boolean | string;
      const result = validationFn(val);

      // Validation failed
      if (result !== true) {
        // Display error message (result is either false or a string error message)
        const errorMessage = typeof result === "string" ? result : "Invalid input";
        setValidationError(errorMessage);
        // Don't resolve - keep the prompt active so user can fix the input
        return;
      }
    }

    // Validation passed or no validation function
    setValue("");
    setValidationError(null);
    currentPrompt.resolve(val);
  }, []);

  // Stable callback - doesn't change between renders
  const handleChange = useCallback((newValue: string): void => {
    setValue(newValue);
    // Clear validation error when user starts typing
    if (validationErrorRef.current) {
      setValidationError(null);
    }
  }, []);

  // Stable callback - doesn't change between renders
  const handleSelect = useCallback((item: { value: unknown; }): void => {
    promptRef.current.resolve(item.value);
  }, []);

  // Handle Escape key for cancellation (only for select/confirm prompts)
  useInput((_input: string, key: { escape?: boolean }) => {
    if (key.escape && promptRef.current.reject) {
      promptRef.current.reject();
    }
  });

  return (
    <Box flexDirection="column" marginTop={1} paddingX={1}>
      {/* Prompt message with indicator */}
      <Box>
        <Text color="green">?</Text>
        <Text> </Text>
        <Text bold>{prompt.message}</Text>
      </Box>

      {/* Input area */}
      <Box marginTop={1} paddingLeft={1} flexDirection="column">
        {prompt.type === "text" && (
          <>
            <Box
              borderStyle="round"
              borderColor="gray"
              borderDimColor
              backgroundColor="black"
              paddingX={2}
              paddingY={1}
              flexDirection="column"
            >
              <Box>
                <LineInput
                  value={value}
                  onChange={handleChange}
                  onSubmit={handleSubmit}
                  placeholder="Ask anything..."
                  showCursor
                />
              </Box>
            </Box>
            {/* Validation error message */}
            {validationError && (
              <Box marginTop={1} paddingLeft={1} paddingRight={1} borderStyle="round" borderColor="red">
                <Text color="red" bold>✗ {validationError}</Text>
              </Box>
            )}
          </>
        )}
        {prompt.type === "password" && (
          <>
            <Box
              borderStyle="round"
              borderColor="gray"
              borderDimColor
              backgroundColor="black"
              paddingX={2}
              paddingY={1}
              flexDirection="column"
            >
              <Box>
                <Text color="green">{">"} </Text>
                <LineInput
                  value={value}
                  onChange={handleChange}
                  onSubmit={handleSubmit}
                  mask="*"
                />
              </Box>
            </Box>
            {/* Validation error message */}
            {validationError && (
              <Box marginTop={1} paddingLeft={1} paddingRight={1} borderStyle="round" borderColor="red">
                <Text color="red" bold>✗ {validationError}</Text>
              </Box>
            )}
          </>
        )}
        {prompt.type === "select" && (
          <SelectInput
            items={prompt.options?.choices || []}
            onSelect={handleSelect}
            indicatorComponent={IndicatorComponent}
            itemComponent={ItemComponent}
          />
        )}
        {prompt.type === "checkbox" && (
          <ScrollableMultiSelect
            options={prompt.options?.choices ?? []}
            defaultSelected={prompt.options?.defaultSelected}
            pageSize={10}
            onSubmit={(selectedValues) => prompt.resolve(selectedValues)}
          />
        )}

        {prompt.type === "confirm" && (
          <SelectInput
            items={[
              { label: "Yes", value: true },
              { label: "No", value: false },
            ]}
            onSelect={handleSelect}
            indicatorComponent={IndicatorComponent}
            itemComponent={ItemComponent}
          />
        )}
      </Box>
    </Box>
  );
}

// Export memoized version to prevent unnecessary re-renders
export const Prompt = React.memo(PromptComponent);
