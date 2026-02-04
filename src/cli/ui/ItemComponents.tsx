import { Box, Text } from "ink";
import React from "react";

export function IndicatorComponent({ isSelected = false }: { isSelected?: boolean }): React.ReactElement {
  return (
    <Box marginRight={1}>
      <Text color="green">
        {isSelected ? ">" : " "}
      </Text>
    </Box>
  );
}

export function ItemComponent({
  isSelected = false,
  label
}: {
  isSelected?: boolean;
  label: string;
}): React.ReactElement {
  return (
    <Box marginBottom={1}>
      <Text
        color={isSelected ? "green" : "white"}
        bold={isSelected}
      >
        {label}
      </Text>
    </Box>
  );
}
