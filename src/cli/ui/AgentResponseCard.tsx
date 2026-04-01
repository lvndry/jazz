import { Box, Text } from "ink";
import React from "react";
import { TerminalText } from "./components/TerminalText";
import { PADDING, THEME } from "./theme";

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
    <Box
      flexDirection="column"
      marginTop={2}
      marginBottom={1}
      paddingX={PADDING.content}
    >
      <Box>
        <Text color={THEME.agent}>◆</Text>
        <Text> </Text>
        <Text
          bold
          color={THEME.agent}
        >
          {agentName}
        </Text>
        <Text dimColor> response</Text>
        <Text color={THEME.agent}>:</Text>
      </Box>

      <Box
        marginTop={1}
        paddingLeft={PADDING.content}
      >
        {/* Do NOT force a color here; allow ANSI styling (chalk/marked-terminal) to render. */}
        <TerminalText>{content}</TerminalText>
      </Box>

      {/* Bottom spacing */}
      <Box marginTop={1} />
    </Box>
  );
}
