import { Box, Text } from "ink";
import React, { useEffect, useRef, useState } from "react";
import type { ActivityState } from "./activity-state";
import { ActivityIndicator } from "./components/ActivityIndicator";
import { getGlyphs } from "./glyphs";
import { PADDING, THEME } from "./theme";

const G = getGlyphs();

/** Seconds before the elapsed counter appears (avoids a "0s" flash). */
const ELAPSED_VISIBLE_AFTER_S = 2;

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest.toString().padStart(2, "0")}s`;
}

/**
 * Self-ticking elapsed counter. Resets whenever `resetKey` changes; when
 * `externalStart` is provided (e.g. a tool's real start timestamp) it wins
 * over the phase-entry time. Ticks once a second so long waits visibly
 * advance instead of looking hung.
 */
function useElapsedSeconds(resetKey: string, externalStart?: number): number {
  const startRef = useRef(Date.now());
  const keyRef = useRef(resetKey);
  if (keyRef.current !== resetKey) {
    keyRef.current = resetKey;
    startRef.current = Date.now();
  }
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => clearInterval(interval);
  }, []);
  const start = externalStart ?? startRef.current;
  return Math.max(0, Math.floor((Date.now() - start) / 1000));
}

function ElapsedText({ seconds }: { seconds: number }): React.ReactElement | null {
  if (seconds < ELAPSED_VISIBLE_AFTER_S) return null;
  return <Text dimColor> · {formatElapsed(seconds)}</Text>;
}

type TodoStatus = "pending" | "in_progress" | "unverified" | "completed" | "cancelled";

function todoStatusGlyph(status: TodoStatus): string {
  switch (status) {
    case "completed":
      return G.success;
    // Told apart from completed by shape, not only by hue: "believed done" and "shown to
    // work" are different claims, and a reader scanning the list has to see which is which.
    case "unverified":
      return G.warn;
    case "in_progress":
      return G.proposed;
    case "cancelled":
      return G.error;
    case "pending":
    default:
      return G.pending;
  }
}

function todoStatusColor(status: TodoStatus): string {
  switch (status) {
    case "completed":
      return THEME.success;
    case "unverified":
      return THEME.warning;
    case "in_progress":
      return THEME.agent;
    case "cancelled":
      return THEME.muted;
    case "pending":
    default:
      return THEME.warning;
  }
}

function AgentHeader({
  agentName,
  label,
  animated = false,
  elapsedSeconds,
}: {
  agentName: string;
  label: string;
  animated?: boolean;
  elapsedSeconds?: number;
}): React.ReactElement {
  return (
    <Box>
      {animated ? (
        <>
          <ActivityIndicator color={THEME.agent} />
          <Text> </Text>
        </>
      ) : (
        <Text color={THEME.agent}>{G.bullet} </Text>
      )}
      <Text
        bold
        color={THEME.agent}
      >
        {agentName}
      </Text>
      <Text dimColor> {label}…</Text>
      {elapsedSeconds !== undefined ? <ElapsedText seconds={elapsedSeconds} /> : null}
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
  const earliestToolStart =
    activity.phase === "tool-execution" && activity.tools.length > 0
      ? Math.min(...activity.tools.map((tool) => tool.startedAt))
      : undefined;
  const elapsedSeconds = useElapsedSeconds(activity.phase, earliestToolStart);

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
            <ActivityIndicator color={THEME.agent} />
            <Text> </Text>
            <Text
              bold
              color={THEME.agent}
            >
              {activity.agentName}
            </Text>
            <Text dimColor> {activity.label}…</Text>
            <Text dimColor>
              {" "}
              ({activity.provider}/{activity.model})
            </Text>
            <ElapsedText seconds={elapsedSeconds} />
          </Box>
        </Box>
      );

    case "thinking":
      // The reasoning body itself is rendered by the dedicated ephemeral
      // panel (see EphemeralPanel.tsx). Here we only show the "is thinking"
      // status header so we don't duplicate the live content.
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
            elapsedSeconds={elapsedSeconds}
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
            elapsedSeconds={elapsedSeconds}
          />
        </Box>
      );

    case "tool-execution": {
      const uniqueNames = Array.from(new Set(activity.tools.map((t) => t.toolName)));
      const isManagingTodos = uniqueNames.includes("manage_todos");
      const classifying = activity.tools.some((tool) => tool.classifying === true);
      const label =
        isManagingTodos && activity.todoSnapshot && activity.todoSnapshot.length > 0
          ? "Updating todo list…"
          : classifying && uniqueNames.length === 1
            ? `Classifying ${uniqueNames[0]}…`
            : uniqueNames.length === 1
              ? `Running ${uniqueNames[0]}…`
              : `Running ${uniqueNames.length} tools… (${uniqueNames.join(", ")})`;
      return (
        <Box
          flexDirection="column"
          marginTop={1}
          paddingX={PADDING.content}
        >
          <Box>
            <ActivityIndicator color={THEME.agent} />
            <Text color={THEME.agent}> {label}</Text>
            <ElapsedText seconds={elapsedSeconds} />
          </Box>
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
