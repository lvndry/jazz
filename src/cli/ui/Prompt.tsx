import { Box, Text, useInput } from "ink";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Suggestion } from "@/core/interfaces/presentation";
import { filterCommandsByPrefix, type ChatCommandInfo } from "@/services/chat/commands";
import { ChatInput } from "./components/ChatInput";
import { FilePicker } from "./components/FilePicker";
import { Questionnaire } from "./components/Questionnaire";
import { ScrollableMultiSelect } from "./components/ScrollableMultiSelect";
import { ScrollableSelect } from "./components/ScrollableSelect";
import { SearchSelect } from "./components/SearchSelect";
import { TextInput } from "./components/TextInput";
import { getGlyphs } from "./glyphs";
import { InputResults, useInputHandler, useTextInput } from "./hooks/use-input-service";
import { store } from "./store";
import { PADDING, THEME } from "./theme";
import type { PromptState } from "./types";

const G = getGlyphs();

const COMMAND_SUGGESTIONS_PRIORITY = 50;

// Above TEXT_INPUT (100) so ↑ recalls history on a single-line buffer, below
// command suggestions (50) and queue recall (60) so those win when active.
const INPUT_HISTORY_PRIORITY = 80;

/**
 * Cap the dropdown height. Tall live frames are the trigger for Ink's
 * shrinking-region erase bug, and a 20-row dropdown is unscannable anyway.
 */
const MAX_VISIBLE_SUGGESTIONS = 8;

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
      <Text
        color={isSelected ? THEME.selected : "white"}
        bold={isSelected}
      >
        {isSelected ? "> " : "  "}/{command.name}
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
    if (validate !== undefined && validate !== null && typeof validate === "function") {
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

  const textInputActive = prompt.type === "chat";
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
  const suggestionWindowStart = Math.min(
    Math.max(0, selectedSuggestionIndex - MAX_VISIBLE_SUGGESTIONS + 1),
    Math.max(0, filteredCommands.length - MAX_VISIBLE_SUGGESTIONS),
  );
  const visibleSuggestions = filteredCommands.slice(
    suggestionWindowStart,
    suggestionWindowStart + MAX_VISIBLE_SUGGESTIONS,
  );
  const hiddenSuggestionsBelow =
    filteredCommands.length - suggestionWindowStart - visibleSuggestions.length;

  // Keep selected index in bounds when list changes
  useEffect(() => {
    if (filteredCommands.length > 0) {
      setSelectedSuggestionIndex((i) => Math.min(i, filteredCommands.length - 1));
    }
  }, [filteredCommands.length]);

  // Refs for command-suggestions handler so it sees latest state
  const setSelectedSuggestionIndexRef = useRef(setSelectedSuggestionIndex);
  const filteredCommandsRef = useRef(filteredCommands);
  const selectedSuggestionIndexRef = useRef(selectedSuggestionIndex);
  const valueRef = useRef(value);
  setSelectedSuggestionIndexRef.current = setSelectedSuggestionIndex;
  filteredCommandsRef.current = filteredCommands;
  selectedSuggestionIndexRef.current = selectedSuggestionIndex;
  valueRef.current = value;

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
        setSelectedSuggestionIndexRef.current(Math.min(commands.length - 1, idx + 1));
        return InputResults.consumed();
      }
      if (action.type === "tab" && commands[idx]) {
        const nextValue = "/" + commands[idx].name + " ";
        setValueRef.current(nextValue, nextValue.length);
        setSelectedSuggestionIndexRef.current(0);
        return InputResults.consumed();
      }
      if (action.type === "submit" && commands[idx]) {
        // A fully typed command submits on the first Enter — only incomplete
        // prefixes get completed in place (second Enter then submits).
        const typed = valueRef.current.trim();
        const isExactCommand = commands.some((cmd) => "/" + cmd.name === typed);
        if (isExactCommand) {
          return InputResults.ignored();
        }
        const nextValue = "/" + commands[idx].name + " ";
        setValueRef.current(nextValue, nextValue.length);
        setSelectedSuggestionIndexRef.current(0);
        return InputResults.consumed();
      }
      return InputResults.ignored();
    },
    deps: [commandSuggestionsEnabled, suggestionsVisible],
  });

  // ↑/↓ history recall of previously sent messages. Navigation starts only
  // from an empty buffer (a typed draft is never clobbered); while
  // navigating, editing the recalled text ends navigation.
  const historyIndexRef = useRef<number | null>(null);

  useInputHandler({
    id: "chat-input-history",
    priority: INPUT_HISTORY_PRIORITY,
    isActive: prompt.type === "chat" && !suggestionsVisible,
    onInput: (action) => {
      if (action.type !== "up" && action.type !== "down") return InputResults.ignored();
      const history = store.getInputHistory();
      if (history.length === 0) return InputResults.ignored();

      const currentValue = valueRef.current;
      const index = historyIndexRef.current;
      const navigating = index !== null && currentValue === history[index];

      if (action.type === "up") {
        if (!navigating && currentValue.length > 0) return InputResults.ignored();
        const nextIndex = navigating ? Math.max(0, index - 1) : history.length - 1;
        const recalled = history[nextIndex] ?? "";
        historyIndexRef.current = nextIndex;
        setValueRef.current(recalled, recalled.length);
        return InputResults.consumed();
      }

      // down — only meaningful while navigating
      if (!navigating) return InputResults.ignored();
      if (index >= history.length - 1) {
        historyIndexRef.current = null;
        setValueRef.current("", 0);
        return InputResults.consumed();
      }
      const nextIndex = index + 1;
      const recalled = history[nextIndex] ?? "";
      historyIndexRef.current = nextIndex;
      setValueRef.current(recalled, recalled.length);
      return InputResults.consumed();
    },
    deps: [prompt.type, suggestionsVisible],
  });

  // Track the previous prompt's type so we only reset the input buffer when
  // the prompt's *kind* changes (e.g. confirm → chat) rather than on every
  // prompt change. Without this, anything the user typed into QueueInput
  // while the agent was busy would be wiped the instant the next chat prompt
  // arrives, since this Prompt component remounts and the effect fires.
  const previousPromptTypeRef = useRef<string | null>(null);

  useEffect(() => {
    const rawDefaultValue = prompt.options?.["defaultValue"];
    const hasExplicitDefault = prompt.type === "chat" && typeof rawDefaultValue === "string";

    if (hasExplicitDefault) {
      // Caller explicitly seeded the input — honor it.
      const defaultValue = rawDefaultValue;
      setValue(defaultValue, defaultValue.length);
    }
    // Otherwise preserve whatever's already in the shared text-input buffer.
    // It may hold text typed in QueueInput during the busy phase, or a chat
    // draft interrupted by a select/confirm prompt — non-chat prompt types
    // use their own input ids, so nothing of theirs bleeds into this buffer
    // and there is no need to clear it on prompt-kind changes (doing so wiped
    // half-typed drafts whenever another prompt interjected).

    previousPromptTypeRef.current = prompt.type;
    setValidationError(null);
    setSelectedSuggestionIndex(0);
  }, [prompt, setValue]);

  useEffect(() => {
    // Clear validation error when user edits input
    if (validationErrorRef.current) {
      setValidationError(null);
    }
  }, [value]);

  // Escape: cancel when the prompt is cancellable; otherwise (chat) clear
  // the current draft so Escape isn't a silent no-op.
  useInput((_input: string, key: { escape?: boolean }) => {
    if (!key.escape) return;
    if (promptRef.current.reject) {
      promptRef.current.reject();
      return;
    }
    if (promptRef.current.type === "chat" && valueRef.current.length > 0) {
      setValueRef.current("", 0);
    }
  });

  return (
    <Box
      flexDirection="column"
      marginTop={1}
      paddingX={PADDING.content}
      paddingY={0}
    >
      {/* Path shown on its own static line above everything */}
      {workingDirectory && (
        <Box marginBottom={0}>
          <Text dimColor>{workingDirectory}</Text>
        </Box>
      )}

      {/* Question header — only for non-chat prompts */}
      {prompt.type !== "chat" && (
        <Box>
          <Text color={THEME.primary}>?</Text>
          <Text> </Text>
          <Text bold>{prompt.message}</Text>
        </Box>
      )}

      <Box
        marginTop={1}
        paddingLeft={1}
        flexDirection="column"
      >
        {prompt.type === "chat" && (
          <>
            <Box flexDirection="row">
              <Text
                color={THEME.prompt}
                bold
              >
                {G.promptCursor}{" "}
              </Text>
              <Box
                flexDirection="column"
                flexGrow={1}
              >
                <ChatInput
                  value={value}
                  cursor={cursor}
                  placeholder="Ask anything..."
                  showCursor
                  textColor="white"
                />
              </Box>
            </Box>
            {suggestionsVisible && (
              <Box
                marginTop={1}
                flexDirection="column"
              >
                <Text dimColor>Commands (↑/↓ select · Tab complete · Enter run):</Text>
                {visibleSuggestions.map((cmd, index) => (
                  <CommandSuggestionItem
                    key={cmd.name}
                    command={cmd}
                    isSelected={suggestionWindowStart + index === selectedSuggestionIndex}
                  />
                ))}
                {hiddenSuggestionsBelow > 0 && (
                  <Box marginLeft={1}>
                    <Text dimColor> …and {hiddenSuggestionsBelow} more</Text>
                  </Box>
                )}
              </Box>
            )}
            {validationError && (
              <Box marginTop={1}>
                <Text
                  color={THEME.error}
                  bold
                >
                  {G.error} {validationError}
                </Text>
              </Box>
            )}
          </>
        )}
        {prompt.type === "password" && (
          <TextInput
            inputId={`password-${prompt.message}`}
            mask="*"
            maskRevealTail={5}
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
            placeholder={(prompt.options?.["placeholder"] as string) ?? "Type to search..."}
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
        {prompt.type === "text" &&
          (() => {
            const validate = prompt.options?.["validate"] as
              | ((input: string) => boolean | string)
              | undefined;
            return (
              <TextInput
                inputId={prompt.message}
                defaultValue={(prompt.options?.["defaultValue"] as string) ?? ""}
                placeholder={(prompt.options?.["placeholder"] as string) ?? ""}
                {...(validate ? { validate } : {})}
                onSubmit={(value: string) => prompt.resolve(value)}
                onCancel={() => prompt.reject?.()}
              />
            );
          })()}
        {prompt.type === "hidden" && <HiddenInput onSubmit={() => prompt.resolve("")} />}
        {prompt.type === "questionnaire" && (
          <Questionnaire
            suggestions={(prompt.options?.["suggestions"] as readonly Suggestion[]) ?? []}
            allowCustom={(prompt.options?.["allowCustom"] as boolean) !== false}
            allowMultiple={(prompt.options?.["allowMultiple"] as boolean) === true}
            onSubmit={(value) => prompt.resolve(value)}
            onCancel={() => prompt.reject?.()}
          />
        )}
        {prompt.type === "filepicker" && (
          <FilePicker
            basePath={(prompt.options?.["basePath"] as string) ?? process.cwd()}
            extensions={prompt.options?.["extensions"] as readonly string[] | undefined}
            includeDirectories={(prompt.options?.["includeDirectories"] as boolean) ?? false}
            onSelect={(path) => prompt.resolve(path)}
            onCancel={() => prompt.reject?.()}
          />
        )}
      </Box>
    </Box>
  );
}

export const Prompt = React.memo(PromptComponent);
