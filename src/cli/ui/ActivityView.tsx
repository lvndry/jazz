import { Box, Text } from "ink";
import React from "react";
import type { ActivityState } from "./activity-state";
import { AnimatedEllipsis } from "./components/AnimatedEllipsis";
import { TerminalText } from "./components/TerminalText";
import { getGlyphs } from "./glyphs";
import { PADDING, THEME } from "./theme";

const G = getGlyphs();

function todoStatusGlyph(status: "pending" | "in_progress" | "completed" | "cancelled"): string {
  switch (status) {
    case "completed":
      return G.success;
    case "in_progress":
      return G.proposed;
    case "cancelled":
      return G.error;
    case "pending":
    default:
      return G.pending;
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
  animated = false,
}: {
  agentName: string;
  label: string;
  animated?: boolean;
}): React.ReactElement {
  return (
    <Box>
      <Text color={THEME.agent}>{G.bullet}</Text>
      <Text> </Text>
      <Text
        bold
        color={THEME.agent}
      >
        {agentName}
      </Text>
      <Text dimColor> {label}</Text>
      {animated ? (
        <AnimatedEllipsis
          label=""
          color={THEME.agent}
        />
      ) : null}
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
      marginTop={0}
      paddingLeft={PADDING.content}
      flexDirection="column"
    >
      <Box>
        <Text color={THEME.reasoning}>{G.arrow} </Text>
        <Text
          color={THEME.reasoning}
          italic
        >
          Reasoning
        </Text>
        {isThinking && (
          <AnimatedEllipsis
            label=""
            color={THEME.reasoning}
          />
        )}
      </Box>
      {reasoning && (
        <Box marginTop={0}>
          <TerminalText color={THEME.reasoning}>{reasoning}</TerminalText>
        </Box>
      )}
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

    case "awaiting":
      return (
        <Box
          flexDirection="column"
          marginTop={1}
          paddingX={PADDING.content}
        >
          <Box>
            <Text color={THEME.agent}>{G.bullet}</Text>
            <Text> </Text>
            <Text
              bold
              color={THEME.agent}
            >
              {activity.agentName}
            </Text>
            <Text dimColor> {activity.label}</Text>
            <AnimatedEllipsis
              label=""
              color={THEME.agent}
            />
            <Text dimColor>
              {" "}
              ({activity.provider}/{activity.model})
            </Text>
          </Box>
        </Box>
      );

    case "thinking":
      return (
        <Box
          flexDirection="column"
          marginTop={1}
          paddingX={PADDING.content}
        >
          <AgentHeader
            agentName={activity.agentName}
            label="is thinking"
            animated
          />
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
          paddingX={PADDING.content}
        >
          <AgentHeader
            agentName={activity.agentName}
            label="is responding"
            animated
          />
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
        <Box
          flexDirection="column"
          marginTop={1}
          paddingX={PADDING.content}
        >
          <AnimatedEllipsis
            label={label}
            color={THEME.agent}
          />
          {activity.todoSnapshot && activity.todoSnapshot.length > 0 ? (
            <Box
              marginTop={1}
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
          <Text color={THEME.error}>
            {G.error} {activity.message}
          </Text>
        </Box>
      );

    default:
      return null;
  }
});
