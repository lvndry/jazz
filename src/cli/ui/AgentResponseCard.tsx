import { Box, Text } from "ink";
import React from "react";

export function AgentResponseCard({
  agentName,
  content,
}: {
  agentName: string;
  content: string;
}): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      marginTop={1}
      borderStyle="round"
      borderColor="green"
      paddingX={1}
      paddingY={0}
    >
      <Box>
        <Text color="green">✔</Text>
        <Text> </Text>
        <Text bold color="green">
          {agentName}
        </Text>
        <Text dimColor> replied</Text>
      </Box>
      <Box marginTop={1}>
        {/* Do NOT force a color here; allow ANSI styling (chalk/marked-terminal) to render. */}
        <Text>{content}</Text>
      </Box>
    </Box>
  );
}

