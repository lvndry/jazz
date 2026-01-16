import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import React, { useEffect, useState } from "react";

import { LineInput } from "./LineInput";
import { ScrollableMultiSelect } from "./ScrollableMultiSelect";
import type { PromptState } from "./types";

export function Prompt({ prompt }: { prompt: PromptState }): React.ReactElement {
  const [value, setValue] = useState("");

  useEffect(() => {
    // React can batch `setPrompt(null)` + `setPrompt(nextPrompt)`, so this component
    // may not unmount between prompts. Ensure the input is reset for each new prompt.
    const rawDefaultValue = prompt.options?.["defaultValue"];
    const defaultValue =
      prompt.type === "text" && typeof rawDefaultValue === "string"
        ? rawDefaultValue
        : "";

    setValue(defaultValue);
  }, [prompt]);

  function handleSubmit(val: string): void {
    setValue("");
    prompt.resolve(val);
  }

  function handleSelect(item: { value: unknown }): void {
    prompt.resolve(item.value);
  }

  return (
    <Box
      flexDirection="column"
      marginTop={1}
      borderStyle="round"
      borderColor="green"
      padding={1}
    >
      <Text bold>{prompt.message}</Text>
      <Box marginTop={1}>
        {prompt.type === "text" && (
          <Box>
            <Text color="green">{">"} </Text>
            <LineInput
              value={value}
              onChange={setValue}
              onSubmit={handleSubmit}
              resetKey={prompt.message}
            />
          </Box>
        )}
        {prompt.type === "password" && (
          <Box>
            <Text color="green">{">"} </Text>
            <LineInput
              value={value}
              onChange={setValue}
              onSubmit={handleSubmit}
              mask="*"
              resetKey={prompt.message}
            />
          </Box>
        )}
        {prompt.type === "select" && (
          <SelectInput
            items={prompt.options?.choices || []}
            onSelect={handleSelect}
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
          />
        )}
      </Box>
    </Box>
  );
}
