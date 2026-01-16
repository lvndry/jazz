import { Box, Text } from "ink";
import React from "react";
import type { LogEntry } from "./types";

export function LogList({ logs }: { logs: LogEntry[] }): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      marginBottom={1}
    >
      {logs.map((log, index) => (
        <Box key={index} flexDirection="column">
          {typeof log.message === "string" ? (
            <Box marginBottom={0}>
              {getIcon(log.type)}
              <Text> </Text>
              {log.type === "log" ? (
                // Important: don't force a color for plain logs so ANSI styling (chalk/marked)
                // can render correctly and not get overwritten by Ink's `color` prop.
                <Text>{log.message}</Text>
              ) : (
                <Text dimColor={log.type === "debug"} color={getColor(log.type)}>
                  {log.message}
                </Text>
              )}
            </Box>
          ) : log.message._tag === "ink" && React.isValidElement(log.message.node) ? (
            <Box marginBottom={0}>{log.message.node}</Box>
          ) : (
            <Box marginBottom={0}>
              {getIcon("warn")}
              <Text> </Text>
              <Text color="yellow">[Unsupported UI output]</Text>
            </Box>
          )}
        </Box>
      ))}
    </Box>
  );
}

function getIcon(type: LogEntry["type"]): React.ReactElement {
  switch (type) {
    case "success":
      return <Text color="green">✔</Text>;
    case "error":
      return <Text color="red">✖</Text>;
    case "warn":
      return <Text color="yellow">⚠</Text>;
    case "info":
      return <Text color="blue">ℹ</Text>;
    case "debug":
      return <Text dimColor>🐛</Text>;
    case "log":
      return <Text>•</Text>;
  }
}

function getColor(type: LogEntry["type"]): string {
  switch (type) {
    case "success":
      return "green";
    case "error":
      return "red";
    case "warn":
      return "yellow";
    case "debug":
      return "gray";
    default:
      return "white";
  }
}
