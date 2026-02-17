import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import React from "react";
import type { ActivityState } from "./activity-state";
import { PreWrappedText } from "./components/PreWrappedText";
import { THEME } from "./theme";
import { padLines } from "../presentation/markdown-formatter";

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
      paddingLeft={1}
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
      {reasoning && <PreWrappedText dimColor>{reasoning}</PreWrappedText>}
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
          paddingX={2}
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
          paddingX={2}
        >
          {/*
            Intentionally no live "Agent is responding…" header here.

            Long responses are progressively flushed into Ink's <Static> region
            (via OutputIsland). If we keep the header in the live area, flushed
            static chunks appear *above* it, splitting the message and creating
            a bad UX. We instead print the response header to Static at `text_start`.
          */}

          {activity.reasoning && (
            <>
              <Box marginTop={0}>
                <Text dimColor>{"─".repeat(40)}</Text>
              </Box>
              <ReasoningSection
                reasoning={activity.reasoning}
                isThinking={false}
              />
              <Box
                marginTop={1}
                paddingLeft={2}
                flexDirection="column"
              >
                <Text dimColor>{"─".repeat(40)}</Text>
                <Box>
                  <Text dimColor>{"▸ "}</Text>
                  <Text
                    dimColor
                    italic
                  >
                    Response
                  </Text>
                </Box>
              </Box>
            </>
          )}

          {activity.text && (
            <Box
              marginTop={activity.reasoning ? 0 : 1}
              flexDirection="column"
            >
              {/* Left padding is baked into the string via padLines() upstream
                  (in buildThinkingOrStreamingActivity). This avoids a nested
                  Box with paddingLeft that Yoga can intermittently miscalculate
                  during frequent live-area re-renders. */}
              <PreWrappedText>{padLines(activity.text, 2)}</PreWrappedText>
            </Box>
          )}
        </Box>
      );

    case "tool-execution": {
      const uniqueNames = Array.from(new Set(activity.tools.map((t) => t.toolName)));
      const label =
        uniqueNames.length === 1
          ? `Running ${uniqueNames[0]}…`
          : `Running ${uniqueNames.length} tools… (${uniqueNames.join(", ")})`;
      return (
        <Box
          paddingX={2}
          marginTop={1}
        >
          <Text color="yellow">
            <Spinner type="dots" />
          </Text>
          <Text color="yellow"> {label}</Text>
        </Box>
      );
    }

    case "error":
      return (
        <Box
          paddingX={2}
          marginTop={1}
        >
          <Text color="red">{activity.message}</Text>
        </Box>
      );

    default:
      return null;
  }
});
