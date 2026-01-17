import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import React from "react";
import type { LiveStreamState } from "./types";

/**
 * LiveResponse displays the streaming response with a minimal header design.
 * Uses spacing and color instead of box borders for copy-friendly terminal output.
 */
export function LiveResponse({ stream }: { stream: LiveStreamState }): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1} paddingX={1}>
      {/* Minimal header with spinner */}
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

      {/* Subtle separator line */}
      <Box marginTop={0}>
        <Text dimColor>{"─".repeat(40)}</Text>
      </Box>

      {/* Content area - no borders for easy copying */}
      <Box marginTop={1} paddingLeft={1}>
        <Text>{stream.text}</Text>
      </Box>

    {stream.reasoning && (
      <Box marginTop={2} paddingLeft={1} flexDirection="column">
        <Text dimColor italic>
          🧠 Reasoning
        </Text>
        <Text dimColor>{stream.reasoning}</Text>
      </Box>
    )}
    </Box>
  );
}
