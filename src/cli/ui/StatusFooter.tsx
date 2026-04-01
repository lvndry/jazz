import { Box, Text } from "ink";
import React from "react";
import { AnimatedEllipsis } from "./components/AnimatedEllipsis";
import { THEME } from "./theme";

function StatusFooter({
  status,
  workingDirectory,
}: {
  status: string | null;
  workingDirectory: string | null;
}) {
  const hasContent = status || workingDirectory;

  if (!hasContent) return null;

  return (
    <Box
      marginTop={1}
      borderStyle="round"
      borderColor={THEME.borderSoft}
      paddingX={1}
      paddingY={0}
      flexDirection="row"
      justifyContent="space-between"
      width="100%"
    >
      {status && (
        <Box>
          <AnimatedEllipsis
            label={status}
            color={THEME.primary}
          />
        </Box>
      )}
      {workingDirectory && (
        <Box>
          <Text dimColor>{workingDirectory}</Text>
        </Box>
      )}
    </Box>
  );
}

export default React.memo(StatusFooter);
