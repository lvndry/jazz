import { Box, Text } from "ink";
import BigText from "ink-big-text";
import Gradient from "ink-gradient";
import React from "react";
import { THEME } from "./theme";
import packageJson from "../../../package.json";

export const Header = React.memo(function Header() {
  return (
    <Box
      flexDirection="column"
      marginY={1}
      borderStyle="round"
      borderColor={THEME.borderSoft}
      paddingX={1}
      paddingY={0}
    >
      <Box
        justifyContent="space-between"
        width="100%"
      >
        <Box flexDirection="column">
          <Gradient name="morning">
            <BigText
              text="Jazz"
              font="block"
            />
          </Gradient>
          <Text dimColor>
            <Text color={THEME.primary}>v{packageJson.version}</Text> · the modern agent CLI
          </Text>
        </Box>
        <Box alignItems="center">
          <Text color={THEME.agent}>◉</Text>
          <Text dimColor> ready</Text>
        </Box>
      </Box>
    </Box>
  );
});
