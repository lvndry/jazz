import { Box, Text } from "ink";
import React from "react";
import { THEME } from "./theme";

export function IndicatorComponent({
  isSelected = false,
}: {
  isSelected?: boolean;
}): React.ReactElement {
  return (
    <Box marginRight={1}>
      <Text color={THEME.selected}>{isSelected ? ">" : " "}</Text>
    </Box>
  );
}

export function ItemComponent({
  isSelected = false,
  label,
}: {
  isSelected?: boolean;
  label: string;
}): React.ReactElement {
  return (
    <Box marginBottom={1}>
      <Text
        color={isSelected ? THEME.selected : "white"}
        bold={isSelected}
      >
        {label}
      </Text>
    </Box>
  );
}
