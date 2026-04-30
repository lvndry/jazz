import { Box, Text, useInput } from "ink";
import React, { useCallback } from "react";
import { ChatInput } from "./components/ChatInput";
import { getGlyphs } from "./glyphs";
import { useTextInput } from "./hooks/use-input-service";
import { store } from "./store";
import { PADDING, THEME } from "./theme";

const G = getGlyphs();

const PREVIEW_MAX_CHARS = 80;

function formatPreview(queue: string): string {
  const firstLine = queue.split("\n")[0] ?? "";
  if (firstLine.length <= PREVIEW_MAX_CHARS) {
    return queue.includes("\n") ? `${firstLine}…` : firstLine;
  }
  return `${firstLine.slice(0, PREVIEW_MAX_CHARS)}…`;
}

/**
 * Chat input rendered while the agent is busy in chat mode.
 *
 * Pressing Enter appends the buffer to the in-memory message queue (joined
 * with newlines if non-empty); Ctrl-X clears the queue. The queue is drained
 * by chat-service the next time it's about to prompt for input.
 */
export function QueueInput({
  queue,
  workingDirectory,
}: {
  queue: string;
  workingDirectory: string | null;
}): React.ReactElement {
  const handleSubmit = useCallback((val: string): void => {
    if (val.length === 0) return;
    store.appendToQueue(val);
  }, []);

  const { value, cursor, setValue } = useTextInput({
    id: "text-input",
    isActive: true,
    onSubmit: (val) => {
      handleSubmit(val);
      setValue("", 0);
    },
  });

  useInput((input, key) => {
    // Ctrl-X — clear queue. Only act when the user has nothing typed; if they
    // have a buffer, leave Ctrl-X alone so we don't shadow future bindings.
    if (key.ctrl && (input === "x" || input === "\x18") && value.length === 0) {
      store.clearQueue();
    }
  });

  const previewVisible = queue.length > 0;

  return (
    <Box
      flexDirection="column"
      marginTop={1}
      paddingX={PADDING.content}
      paddingY={0}
    >
      {workingDirectory && (
        <Box marginBottom={0}>
          <Text dimColor>{workingDirectory}</Text>
        </Box>
      )}

      {previewVisible && (
        <Box marginTop={1}>
          <Text dimColor>Queued: {formatPreview(queue)} (Ctrl-X to clear)</Text>
        </Box>
      )}

      <Box
        marginTop={1}
        paddingLeft={1}
        flexDirection="row"
      >
        <Text
          color={THEME.prompt}
          bold
        >
          {G.promptCursor}{" "}
        </Text>
        <Box
          flexDirection="column"
          flexGrow={1}
        >
          <ChatInput
            value={value}
            cursor={cursor}
            placeholder="Type to queue for next turn…"
            showCursor
            textColor="white"
          />
        </Box>
      </Box>
    </Box>
  );
}
