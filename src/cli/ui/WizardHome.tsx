import { Box, Text, useApp, useInput } from "ink";
import SelectInput from "ink-select-input";
import React from "react";
import { Header } from "./Header";

/**
 * Menu option for the wizard
 */
export interface WizardMenuOption {
  label: string;
  value: string;
}

interface WizardHomeProps {
  options: WizardMenuOption[];
  onSelect: (value: string) => void;
  onExit: () => void;
}

/**
 * WizardHome - The main interactive home screen for Jazz CLI
 *
 * Displays a branded header with menu options for all Jazz functionality.
 * Uses ink-select-input for keyboard navigation.
 */
export function WizardHome({ options, onSelect, onExit }: WizardHomeProps): React.ReactElement {
  const { exit } = useApp();

  // Handle escape key to exit
  useInput((input, key) => {
    if (key.escape) {
      onExit();
      exit();
    }
    // Also handle 'q' as a quick exit
    if (input === "q") {
      onExit();
      exit();
    }
  });

  // Convert options to ink-select-input format
  const items = options.map((option) => ({
    label: option.label,
    value: option.value,
  }));

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Header />

      {/* Divider */}
      <Box marginY={1}>
        <Text dimColor>{"─".repeat(60)}</Text>
      </Box>

      {/* Menu */}
      <Box flexDirection="column" marginLeft={2}>
        <Box marginBottom={1}>
          <Text dimColor>Select an action:</Text>
        </Box>

        <Box marginTop={1}>
          <SelectInput
            items={items}
            onSelect={(item) => onSelect(item.value)}
            indicatorComponent={IndicatorComponent}
            itemComponent={ItemComponent}
          />
        </Box>
      </Box>

      {/* Footer hint */}
      <Box marginTop={2} marginLeft={2}>
        <Text dimColor>
          Navigate: ↑/↓  •  Select: Enter  •  Exit: Esc
        </Text>
      </Box>
    </Box>
  );
}

/**
 * Custom indicator component for the menu
 */
function IndicatorComponent({ isSelected = false }: { isSelected?: boolean }): React.ReactElement {
  return (
    <Box marginRight={2} width={2}>
      <Text {...(isSelected ? { color: "cyan" } : {})}>
        {isSelected ? "›" : " "}
      </Text>
    </Box>
  );
}

/**
 * Custom item component for styled menu items
 */
function ItemComponent({
  isSelected = false,
  label
}: {
  isSelected?: boolean;
  label: string;
}): React.ReactElement {
  return (
    <Box paddingY={0}>
      <Text
        {...(isSelected ? { color: "cyan" } : { dimColor: true })}
      >
        {label}
      </Text>
    </Box>
  );
}

export default WizardHome;
