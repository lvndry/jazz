import { Box, Text } from "ink";
import BigText from "ink-big-text";
import Gradient from "ink-gradient";
import packageJson from "../../../package.json";

export function Header() {
  return (
    <Box
      marginY={1}
      flexDirection="row"
      alignItems="center"
    >
      <Box flexDirection="column">
        <Gradient name="morning">
          <BigText
            text="Jazz"
            font="block"
          />
        </Gradient>
        <Box
          borderStyle="round"
          borderColor="cyan"
          paddingX={1}
          marginTop={-1}
        >
          <Text color="cyan">v{packageJson.version}</Text>
          <Text> | </Text>
          <Text dimColor>Agentic AI Coding Assistant</Text>
        </Box>
      </Box>
    </Box>
  );
}
