import { Box, Text, useInput } from "ink";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  filterCommandsByPrefix,
  type ChatCommandInfo,
} from "@/services/chat/commands";
import { ChatInput, SHORTCUTS_HINT } from "./components/ChatInput";
import { Questionnaire } from "./components/Questionnaire";
import { ScrollableMultiSelect } from "./components/ScrollableMultiSelect";
import { ScrollableSelect } from "./components/ScrollableSelect";
import { SearchSelect } from "./components/SearchSelect";
import { TextInput } from "./components/TextInput";
import { useInputHandler, InputResults, useTextInput } from "./hooks/use-input-service";
import type { PromptState } from "./types";

const COMMAND_SUGGESTIONS_PRIORITY = 50;

interface CommandSuggestionItemProps {
  command: ChatCommandInfo;
  isSelected: boolean;
}

function CommandSuggestionItem({
  command,
  isSelected,
}: CommandSuggestionItemProps): React.ReactElement {
  return (
    <Box marginLeft={1}>
      <Text color={isSelected ? "green" : "white"} bold={isSelected}>
        {isSelected ? "> " : "  "}
        /{command.name}
      </Text>
      <Text dimColor> – {command.description}</Text>
    </Box>
  );
}

/**
 * Hidden input that waits for Enter key without showing any visible UI.
 * Used for "Press Enter to continue" scenarios.
 */
function HiddenInput({ onSubmit }: { onSubmit: () => void }): React.ReactElement {
  useInput((_input: string, key: { return?: boolean }) => {
    if (key.return) {
      onSubmit();
    }
  });
  return <></>;
}

/**
 * Prompt displays user input prompts with a minimal header design.
 * Uses spacing and color instead of box borders for copy-friendly terminal output.
 */
function PromptComponent({
  prompt,
  workingDirectory = null,
}: {
  prompt: PromptState;
  workingDirectory?: string | null;
}): React.ReactElement {
  const [validationError, setValidationError] = useState<string | null>(null);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);

  // Use refs to avoid recreating callbacks on every render
  const promptRef = useRef(prompt);
  const validationErrorRef = useRef(validationError);
  const setValueRef = useRef<(value: string, cursor?: number) => void>(() => {});
  promptRef.current = prompt;
  validationErrorRef.current = validationError;

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
    setValueRef.current("", 0);
    setValidationError(null);
    currentPrompt.resolve(val);
  }, []);

  const textInputActive =
    prompt.type === "chat" || prompt.type === "password";
  const { value, cursor, setValue } = useTextInput({
    id: "text-input",
    isActive: textInputActive,
    onSubmit: handleSubmit,
  });
  setValueRef.current = setValue;

  const commandSuggestionsEnabled =
    prompt.type === "chat" && Boolean(prompt.options?.commandSuggestions);
  const suggestionPrefix = value.startsWith("/") ? value.slice(1) : "";
  const filteredCommands = useMemo(
    () =>
      commandSuggestionsEnabled && value.startsWith("/")
        ? filterCommandsByPrefix(suggestionPrefix)
        : [],
    [commandSuggestionsEnabled, suggestionPrefix, value],
  );
  const suggestionsVisible = filteredCommands.length > 0;

  // Keep selected index in bounds when list changes
  useEffect(() => {
    if (filteredCommands.length > 0) {
      setSelectedSuggestionIndex((i) =>
        Math.min(i, filteredCommands.length - 1),
      );
    }
  }, [filteredCommands.length]);

  // Refs for command-suggestions handler so it sees latest state
  const setSelectedSuggestionIndexRef = useRef(setSelectedSuggestionIndex);
  const filteredCommandsRef = useRef(filteredCommands);
  const selectedSuggestionIndexRef = useRef(selectedSuggestionIndex);
  setSelectedSuggestionIndexRef.current = setSelectedSuggestionIndex;
  filteredCommandsRef.current = filteredCommands;
  selectedSuggestionIndexRef.current = selectedSuggestionIndex;

  useInputHandler({
    id: "chat-command-suggestions",
    priority: COMMAND_SUGGESTIONS_PRIORITY,
    isActive: commandSuggestionsEnabled && suggestionsVisible,
    onInput: (action) => {
      const commands = filteredCommandsRef.current;
      const idx = selectedSuggestionIndexRef.current;
      if (action.type === "up") {
        setSelectedSuggestionIndexRef.current(Math.max(0, idx - 1));
        return InputResults.consumed();
      }
      if (action.type === "down") {
        setSelectedSuggestionIndexRef.current(
          Math.min(commands.length - 1, idx + 1),
        );
        return InputResults.consumed();
      }
      if (action.type === "submit" && commands[idx]) {
        const nextValue = "/" + commands[idx].name + " ";
        setValueRef.current(nextValue, nextValue.length);
        setSelectedSuggestionIndexRef.current(0);
        return InputResults.consumed();
      }
      return InputResults.ignored();
    },
    deps: [commandSuggestionsEnabled, suggestionsVisible],
  });

  useEffect(() => {
    // React can batch `setPrompt(null)` + `setPrompt(nextPrompt)`, so this component
    // may not unmount between prompts. Ensure the input is reset for each new prompt.
    const rawDefaultValue = prompt.options?.["defaultValue"];
    const defaultValue =
      prompt.type === "chat" && typeof rawDefaultValue === "string"
        ? rawDefaultValue
        : "";

    setValue(defaultValue, defaultValue.length);
    setValidationError(null);
    setSelectedSuggestionIndex(0);
  }, [prompt, setValue]);

  useEffect(() => {
    // Clear validation error when user edits input
    if (validationErrorRef.current) {
      setValidationError(null);
    }
  }, [value]);

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
        {prompt.type === "chat" && (
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
                <ChatInput
                  value={value}
                  cursor={cursor}
                  placeholder="Ask anything..."
                  showCursor
                  textColor="white"
                />
              </Box>
              {/* Command suggestions when typing / */}
              {suggestionsVisible && (
                <Box marginTop={1} flexDirection="column">
                  <Text dimColor> Commands (↑/↓ select, Enter to pick):</Text>
                  {filteredCommands.map((cmd, index) => (
                    <CommandSuggestionItem
                      key={cmd.name}
                      command={cmd}
                      isSelected={index === selectedSuggestionIndex}
                    />
                  ))}
                </Box>
              )}
            </Box>
            {/* Hints below box so terminal selection inside box captures only input text */}
            <Box marginTop={1} flexDirection="column">
              {workingDirectory && (
                <Text dimColor>Current directory: {workingDirectory}</Text>
              )}
              <Text dimColor>{SHORTCUTS_HINT}</Text>
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
          <TextInput
            inputId={`password-${prompt.message}`}
            mask="*"
            onSubmit={(value: string) => prompt.resolve(value)}
            onCancel={() => prompt.reject?.()}
          />
        )}
        {prompt.type === "select" && (
          <ScrollableSelect
            options={prompt.options?.choices ?? []}
            pageSize={10}
            onSelect={(value) => prompt.resolve(value)}
            onCancel={() => prompt.reject?.()}
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
        {prompt.type === "search" && (
          <SearchSelect
            options={prompt.options?.choices ?? []}
            pageSize={10}
            onSelect={(value) => prompt.resolve(value)}
            onCancel={() => prompt.reject?.()}
          />
        )}

        {prompt.type === "confirm" && (
          <ScrollableSelect
            options={[
              { label: "Yes", value: true },
              { label: "No", value: false },
            ]}
            pageSize={10}
            onSelect={(value) => prompt.resolve(value)}
            onCancel={() => prompt.reject?.()}
          />
        )}
        {prompt.type === "text" && (() => {
          const validate = prompt.options?.["validate"] as ((input: string) => boolean | string) | undefined;
          return (
            <TextInput
              inputId={prompt.message}
              defaultValue={(prompt.options?.["defaultValue"] as string) ?? ""}
              {...(validate ? { validate } : {})}
              onSubmit={(value: string) => prompt.resolve(value)}
              onCancel={() => prompt.reject?.()}
            />
          );
        })()}
        {prompt.type === "hidden" && (
          <HiddenInput onSubmit={() => prompt.resolve("")} />
        )}
        {prompt.type === "questionnaire" && (
          <Questionnaire
            suggestions={(prompt.options?.["suggestions"] as readonly string[]) ?? []}
            allowCustom={(prompt.options?.["allowCustom"] as boolean) !== false}
            onSubmit={(value) => prompt.resolve(value)}
            onCancel={() => prompt.reject?.()}
          />
        )}
      </Box>
    </Box>
  );
}

export const Prompt = React.memo(PromptComponent);
