import { Box, Text } from "ink";
import React from "react";

/**
 * AgentResponseCard displays the agent's response with a minimal header design.
 * Uses spacing and color instead of box borders for copy-friendly terminal output.
 */
export function AgentResponseCard({
  agentName,
  content,
}: {
  agentName: string;
  content: string;
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1} paddingX={1}>
      {/* Minimal header with status indicator */}
      <Box>
        <Text color="green">✔</Text>
        <Text> </Text>
        <Text bold color="green">
          {agentName}
        </Text>
        <Text dimColor> replied</Text>
      </Box>

      {/* Subtle separator line */}
      <Box marginTop={0}>
        <Text dimColor>{"─".repeat(40)}</Text>
      </Box>

      {/* Content area - no borders for easy copying */}
      <Box marginTop={1} paddingLeft={1}>
        {/* Do NOT force a color here; allow ANSI styling (chalk/marked-terminal) to render. */}
        <Text>{content}</Text>
      </Box>

      {/* Bottom spacing */}
      <Box marginTop={1} />
    </Box>
  );
}

