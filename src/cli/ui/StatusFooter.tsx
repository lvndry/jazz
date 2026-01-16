import { Box, Text } from "ink";
import Spinner from "ink-spinner";

export default function StatusFooter({ status }: { status: string | null }) {
  if (!status) return null;

  return (
    <Box
      marginTop={1}
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
    >
      <Text color="cyan">
        <Spinner type="dots" />
      </Text>
      <Text> {status}</Text>
    </Box>
  );
}
