import { Box, Text } from "ink";
import React from "react";
import type { LogEntry, LogType } from "./types";

// Pre-created icon elements to avoid creating new React elements on every render
const ICONS: Record<LogType, React.ReactElement> = {
  success: <Text color="green">✔</Text>,
  error: <Text color="red">✖</Text>,
  warn: <Text color="yellow">⚠</Text>,
  info: <Text color="cyan">ℹ</Text>,
  debug: <Text dimColor>•</Text>,
  user: <Text color="cyan">›</Text>,
  log: <></>,
};

const COLORS: Record<LogType, string> = {
  success: "green",
  error: "red",
  warn: "yellow",
  debug: "gray",
  user: "cyan",
  info: "cyan",
  log: "white",
};

/**
 * Individual log entry component - memoized to prevent re-renders
 * when other logs are added to the list.
 *
 * IMPORTANT: Props must be stable for memoization to work effectively.
 * - `log` object reference should be stable (not recreated)
 * - `addSpacing` is a primitive boolean (pre-computed in parent)
 *
 * Without React.memo, every log entry would re-render whenever ANY log
 * is added to the list, causing significant performance degradation
 * during streaming responses.
 */
export const LogEntryItem = React.memo(function LogEntryItem({
  log,
  addSpacing,
}: {
  log: LogEntry;
  addSpacing: boolean;
}): React.ReactElement {
  const icon = ICONS[log.type];
  const color = COLORS[log.type];

  if (typeof log.message === "string") {
    if (log.type === "user") {
      return (
        <Box marginTop={addSpacing ? 1 : 0} marginBottom={1}>
          {icon}
          <Text> </Text>
          <Text color="cyan" bold>{log.message}</Text>
        </Box>
      );
    }

    return (
      <Box marginTop={addSpacing ? 1 : 0} marginBottom={1}>
        {icon}
        <Text> </Text>
        {log.type === "log" ? (
          // Important: don't force a color for plain logs so ANSI styling (chalk/marked)
          // can render correctly and not get overwritten by Ink's `color` prop.
          <Text>{log.message}</Text>
        ) : (
          <Text dimColor={log.type === "debug"} color={color}>
            {log.message}
          </Text>
        )}
      </Box>
    );
  }

  if (log.message._tag === "ink" && React.isValidElement(log.message.node)) {
    return <Box marginTop={addSpacing ? 1 : 0} marginBottom={1}>{log.message.node}</Box>;
  }

  return (
    <Box marginTop={0} marginBottom={1}>
      {ICONS.warn}
      <Text> </Text>
      <Text color="yellow">[Unsupported UI output]</Text>
    </Box>
  );
});
