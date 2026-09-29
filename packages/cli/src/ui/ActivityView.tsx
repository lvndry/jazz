/**
 * Renders the current `ActivityState` phase (thinking, tool call, streaming,
 * etc.) as the live status line shown above the prompt.
 */

import { Box, Text } from "ink";
import React, { useEffect, useRef, useState } from "react";
import type { ActivityState, TodoSnapshotItem } from "./activity-state";
import { ActivityIndicator } from "./components/ActivityIndicator";
import { getGlyphs } from "./glyphs";
import { planProgress, todoLine } from "./models/todo";
import { formatElapsed } from "./text/format";
import { roleStyle } from "./text/roles";
import { PADDING, THEME } from "./theme";

/** Seconds before the elapsed counter appears (avoids a "0s" flash). */
const ELAPSED_VISIBLE_AFTER_S = 2;

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
  return <Text dimColor> · {formatElapsed(seconds * 1000)}</Text>;
}

/**
 * The plan from the shared plan model: its heading and `N of M`, then each item's mark and
 * text set the way the fullscreen live zone sets them.
 */
function PlanList({ todos }: { todos: readonly TodoSnapshotItem[] }): React.ReactElement {
  const glyphs = getGlyphs();
  const { label, progress } = planProgress(todos);
  return (
    <Box
      marginTop={1}
      paddingLeft={PADDING.nested}
      flexDirection="column"
    >
      <Box>
        <Text
          bold
          color={THEME.secondary}
        >
          {label}
        </Text>
        <Text color={THEME.muted}> {progress}</Text>
      </Box>
      {todos.map((todo, index) => {
        const line = todoLine(todo, glyphs);
        return (
          <Box key={`${todo.content}-${index}`}>
            <Text color={roleStyle(line.mark.role).fg}>{line.mark.text}</Text>
            <Text> </Text>
            <Text
              color={roleStyle(line.content.role).fg}
              bold={line.bold}
              strikethrough={line.strikethrough}
            >
              {line.content.text}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
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
        <Text color={THEME.agent}>{getGlyphs().bullet} </Text>
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
            <PlanList todos={activity.todoSnapshot} />
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
            {getGlyphs().error} {activity.message}
          </Text>
        </Box>
      );

    default:
      return null;
  }
});
