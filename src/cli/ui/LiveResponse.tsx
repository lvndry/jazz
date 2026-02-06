import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import React from "react";
import type { LiveStreamState } from "./types";

/**
 * LiveResponse displays the streaming response with a minimal header design.
 * Uses spacing and color instead of box borders for copy-friendly terminal output.
 */
export const LiveResponse = React.memo(function LiveResponse({
  stream,
}: {
  stream: LiveStreamState;
}): React.ReactElement {
  const hasReasoning = stream.reasoning || stream.isThinking;

  return (
    <Box flexDirection="column" marginTop={1} paddingX={1}>
      <Box>
        <Text color="magenta">
          <Spinner type="dots" />
        </Text>
        <Text> </Text>
        <Text bold color="magenta">
          {stream.agentName}
        </Text>
        <Text dimColor>
          {stream.isThinking && !stream.text ? " is thinking…" : " is responding…"}
        </Text>
      </Box>

      <Box marginTop={0}>
        <Text dimColor>{"─".repeat(40)}</Text>
      </Box>

      {hasReasoning && (
        <Box marginTop={1} paddingLeft={1} flexDirection="column">
          <Box>
            <Text dimColor italic>🧠 Reasoning</Text>
            {stream.isThinking && (
              <Text dimColor> <Spinner type="dots" /></Text>
            )}
          </Box>
          {stream.reasoning && <Text dimColor>{stream.reasoning}</Text>}
        </Box>
      )}

      {stream.text && (
        <Box marginTop={1} paddingLeft={1}>
          <Text>{stream.text}</Text>
        </Box>
      )}
    </Box>
  );
});
