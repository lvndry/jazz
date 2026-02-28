import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import React from "react";
import type { ActivityState } from "./activity-state";
import { TerminalText } from "./components/TerminalText";
import { PADDING, THEME } from "./theme";

function todoStatusGlyph(status: "pending" | "in_progress" | "completed" | "cancelled"): string {
  switch (status) {
    case "completed":
      return "✓";
    case "in_progress":
      return "◐";
    case "cancelled":
      return "✗";
    case "pending":
    default:
      return "○";
  }
}

function todoStatusColor(
  status: "pending" | "in_progress" | "completed" | "cancelled",
): "green" | "cyan" | "gray" | "yellow" {
  switch (status) {
    case "completed":
      return "green";
    case "in_progress":
      return "cyan";
    case "cancelled":
      return "gray";
    case "pending":
    default:
      return "yellow";
  }
}
function AgentHeader({
  agentName,
  label,
}: {
  agentName: string;
  label: string;
}): React.ReactElement {
  return (
    <Box>
      <Text color={THEME.agent}>
        <Spinner type="dots" />
      </Text>
      <Text> </Text>
      <Text
        bold
        color={THEME.agent}
      >
        {agentName}
      </Text>
      <Text dimColor> {label}</Text>
    </Box>
  );
}

function ReasoningSection({
  reasoning,
  isThinking,
}: {
  reasoning: string;
  isThinking: boolean;
}): React.ReactElement | null {
  if (!reasoning && !isThinking) return null;

  return (
    <Box
      marginTop={1}
      paddingLeft={PADDING.content}
      flexDirection="column"
    >
      <Box>
        <Text dimColor>{"▸ "}</Text>
        <Text
          dimColor
          italic
        >
          Reasoning
        </Text>
        {isThinking && (
          <Text dimColor>
            {" "}
            <Spinner type="dots" />
          </Text>
        )}
      </Box>
      {reasoning && <TerminalText dimColor>{reasoning}</TerminalText>}
    </Box>
  );
}

/**
 * ActivityView renders the current activity phase as a single live UI region.
 * Replaces the old StatusIsland + StreamIsland (LiveResponse) pair.
 */
export const ActivityView = React.memo(function ActivityView({
  activity,
}: {
  activity: ActivityState;
}): React.ReactElement | null {
  switch (activity.phase) {
    case "idle":
    case "complete":
      return null;

    case "thinking":
      return (
        <Box
          flexDirection="column"
          marginTop={1}
          paddingX={PADDING.content}
        >
          <AgentHeader
            agentName={activity.agentName}
            label="is thinking…"
          />
          <Box marginTop={0}>
            <Text dimColor>{"─".repeat(40)}</Text>
          </Box>
          <ReasoningSection
            reasoning={activity.reasoning}
            isThinking={true}
          />
        </Box>
      );

    case "streaming":
      return (
        <Box
          flexDirection="column"
          marginTop={1}
        >
          <Box paddingX={PADDING.content}>
            <AgentHeader
              agentName={activity.agentName}
              label="is responding…"
            />
          </Box>
        </Box>
      );

    case "tool-execution": {
      const uniqueNames = Array.from(new Set(activity.tools.map((t) => t.toolName)));
      const isManagingTodos = uniqueNames.includes("manage_todos");
      const label =
        isManagingTodos && activity.todoSnapshot && activity.todoSnapshot.length > 0
          ? "Updating todo list…"
          : uniqueNames.length === 1
            ? `Running ${uniqueNames[0]}…`
            : `Running ${uniqueNames.length} tools… (${uniqueNames.join(", ")})`;
      return (
        <Box flexDirection="column">
          <Box
            paddingX={PADDING.content}
            marginTop={1}
          >
            <Text color="yellow">
              <Spinner type="dots" />
            </Text>
            <Text color="yellow"> {label}</Text>
          </Box>
          {activity.todoSnapshot && activity.todoSnapshot.length > 0 ? (
            <Box
              paddingLeft={PADDING.nested}
              flexDirection="column"
            >
              {activity.todoSnapshot.map((todo, index) => (
                <Box key={`${todo.content}-${index}`}>
                  <Text color={todoStatusColor(todo.status)}>{todoStatusGlyph(todo.status)}</Text>
                  <Text> </Text>
                  <Text>{todo.content}</Text>
                </Box>
              ))}
            </Box>
          ) : null}
        </Box>
      );
    }

    case "error":
      return (
        <Box
          paddingX={PADDING.content}
          marginTop={1}
        >
          <Text color="red">{activity.message}</Text>
        </Box>
      );

    default:
      return null;
  }
});
