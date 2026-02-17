import { Box, Text } from "ink";
import React from "react";
import { THEME } from "./theme";
import type { OutputEntryWithId, OutputType } from "./types";

// Pre-created icon elements to avoid creating new React elements on every render
const ICONS: Record<OutputType, React.ReactElement> = {
  success: <Text color={THEME.success}>✔</Text>,
  error: <Text color="red">✖</Text>,
  warn: <Text color="yellow">⚠</Text>,
  info: <Text color={THEME.info}>ℹ</Text>,
  debug: <Text dimColor>•</Text>,
  user: <Text color={THEME.primary}>›</Text>,
  log: <></>,
};

const COLORS: Record<OutputType, string> = {
  success: "green",
  error: "red",
  warn: "yellow",
  debug: "gray",
  user: THEME.primary,
  info: THEME.info,
  log: "white",
};

/**
 * Individual output entry component - memoized to prevent re-renders
 * when other entries are added to the list.
 *
 * IMPORTANT: Props must be stable for memoization to work effectively.
 * - `entry` object reference should be stable (not recreated)
 * - `addSpacing` is a primitive boolean (pre-computed in parent)
 *
 * Without React.memo, every entry would re-render whenever ANY entry
 * is added to the list, causing significant performance degradation
 * during streaming responses.
 */
export const OutputEntryView = React.memo(function OutputEntryView({
  entry,
  addSpacing,
}: {
  entry: OutputEntryWithId;
  addSpacing: boolean;
}): React.ReactElement {
  const icon = ICONS[entry.type];
  const color = COLORS[entry.type];

  if (typeof entry.message === "string") {
    if (entry.type === "user") {
      return (
        <Box
          marginTop={addSpacing ? 1 : 0}
          marginBottom={1}
        >
          {icon}
          <Text> </Text>
          <Text
            color={THEME.primary}
            bold
            wrap="truncate"
          >
            {entry.message}
          </Text>
        </Box>
      );
    }

    // Log entries: render just the text with no icon/space siblings.
    // This keeps Yoga layout minimal — a single Text child in a Box.
    // The caller is responsible for baking any left padding into the string
    // (via padLines) so Yoga doesn't need to compute nested padding.
    if (entry.type === "log") {
      return (
        <Box
          marginTop={addSpacing ? 1 : 0}
          marginBottom={1}
        >
          <Text wrap="truncate">{entry.message}</Text>
        </Box>
      );
    }

    return (
      <Box
        marginTop={addSpacing ? 1 : 0}
        marginBottom={1}
      >
        {icon}
        <Text> </Text>
        <Text
          dimColor={entry.type === "debug"}
          color={color}
          wrap="truncate"
        >
          {entry.message}
        </Text>
      </Box>
    );
  }

  if (entry.message._tag === "ink" && React.isValidElement(entry.message.node)) {
    return (
      <Box
        marginTop={addSpacing ? 1 : 0}
        marginBottom={1}
      >
        {entry.message.node}
      </Box>
    );
  }

  return (
    <Box
      marginTop={0}
      marginBottom={0}
    >
      {ICONS.warn}
      <Text> </Text>
      <Text color="yellow">[Unsupported UI output]</Text>
    </Box>
  );
});
