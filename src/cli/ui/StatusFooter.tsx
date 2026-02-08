import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import React from "react";
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
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
    >
      <Box flexDirection="row">
        {status && (
          <Box marginRight={2}>
            <Text color={THEME.primary}>
              <Spinner type="dots" />
            </Text>
            <Text> {status}</Text>
          </Box>
        )}
        {workingDirectory && (
          <Box>
            <Text color="gray">📁 {workingDirectory}</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}

export default React.memo(StatusFooter);
