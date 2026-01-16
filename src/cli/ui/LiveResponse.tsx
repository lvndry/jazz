import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import React from "react";
import type { LiveStreamState } from "./types";

export function LiveResponse({ stream }: { stream: LiveStreamState }): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      marginTop={1}
      borderStyle="round"
      borderColor="magenta"
      paddingX={1}
      paddingY={0}
    >
      <Box>
        <Text color="magenta">
          <Spinner type="dots" />
        </Text>
        <Text> </Text>
        <Text bold color="magenta">
          {stream.agentName}
        </Text>
        <Text dimColor> is responding…</Text>
      </Box>
      <Box marginTop={1}>
        <Text>{stream.text}</Text>
      </Box>
    </Box>
  );
}

