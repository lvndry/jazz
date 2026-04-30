import { Box, Text, useInput } from "ink";
import React, { useCallback } from "react";
import { ChatInput } from "./components/ChatInput";
import { getGlyphs } from "./glyphs";
import { useTextInput } from "./hooks/use-input-service";
import { store } from "./store";
import { PADDING, THEME } from "./theme";

const G = getGlyphs();

/** Per-entry truncation width — keeps the preview block bounded vertically. */
const ENTRY_PREVIEW_MAX_CHARS = 80;

/** Show at most this many entries; older ones become a `+N more` line. */
const MAX_VISIBLE_ENTRIES = 5;

function truncateEntry(entry: string): string {
  // Collapse newlines inside a single queued entry so each entry occupies one
  // line in the preview. Multi-line entries are rare (paste) but possible.
  const oneLine = entry.replace(/\n+/g, " ↵ ");
  if (oneLine.length <= ENTRY_PREVIEW_MAX_CHARS) return oneLine;
  return `${oneLine.slice(0, ENTRY_PREVIEW_MAX_CHARS)}…`;
}

/**
 * Chat input rendered while the agent is busy in chat mode.
 *
 * Each Enter appends a new entry to the in-memory message queue. The queue
 * preview shows entries stacked one per line; on agent completion the chat
 * loop drains the queue (joining with `\n`) and sends it as a single
 * combined turn. `Ctrl-X` clears the queue when the input buffer is empty.
 */
export function QueueInput({
  queue,
  workingDirectory,
}: {
  queue: readonly string[];
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

  const visibleEntries = queue.slice(-MAX_VISIBLE_ENTRIES);
  const overflowCount = queue.length - visibleEntries.length;

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

      {queue.length > 0 && (
        <Box
          marginTop={1}
          flexDirection="column"
        >
          <Text dimColor>Queued ({queue.length}) · Ctrl-X to clear</Text>
          {overflowCount > 0 && <Text dimColor> …and {overflowCount} earlier</Text>}
          {visibleEntries.map((entry, index) => (
            <Text
              key={`${queue.length - visibleEntries.length + index}`}
              dimColor
            >
              {"  • "}
              {truncateEntry(entry)}
            </Text>
          ))}
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
