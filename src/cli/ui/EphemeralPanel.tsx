import { Box, Text } from "ink";
import React, { useEffect, useState } from "react";
import { PreWrappedText } from "./components/PreWrappedText";
import { getGlyphs } from "./glyphs";
import type { EphemeralRegion } from "./store";
import { PADDING, PADDING_BUDGET, THEME } from "./theme";
import { dimReasoningMarkdownOutput } from "../presentation/format-utils";
import { formatMarkdown, wrapToWidth } from "../presentation/markdown-formatter";
import { getTerminalWidth } from "../utils/string-utils";

const G = getGlyphs();

function elapsed(startedAt: number): string {
  const seconds = Math.max(0, (Date.now() - startedAt) / 1000);
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}m ${s}s`;
}

/**
 * Bounded live-region panel rendered above the prompt while an in-flight
 * activity is producing output. Shows a label header and the last N lines
 * of the activity's tail. Pre-wraps text upstream to avoid Yoga's
 * character-by-character wrapping under load.
 */
export function EphemeralPanel({ region }: { region: EphemeralRegion }): React.ReactElement {
  // Tick once a second so the elapsed header keeps advancing even when the
  // region receives no new content — a stalled panel otherwise looks hung.
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  const headerColor = region.kind === "reasoning" ? THEME.reasoning : THEME.agent;
  const tailColor = region.kind === "reasoning" ? THEME.reasoning : "white";

  const availableWidth = Math.max(20, getTerminalWidth() - PADDING_BUDGET - PADDING.content);
  // Format markdown for reasoning panels so inline code, bold, lists etc.
  // render the same way they do in the main response stream. Subagent panels
  // already get raw output (their content can be anything — JSON, search
  // results, code) so we leave that untouched.
  const rawTail = region.tail.join("\n");
  // Reasoning renders markdown but dimmed/italic — the live panel should read
  // as quiet planning text, matching the settled scrollback styling, instead
  // of competing with the response for attention.
  const formattedTail =
    region.kind === "reasoning" ? dimReasoningMarkdownOutput(formatMarkdown(rawTail)) : rawTail;
  const wrappedTail = wrapToWidth(formattedTail, availableWidth);

  return (
    <Box
      flexDirection="column"
      marginTop={1}
      paddingLeft={PADDING.content}
    >
      <Box>
        <Text color={headerColor}>{G.arrow} </Text>
        <Text
          color={headerColor}
          italic
        >
          {region.label}
        </Text>
        <Text dimColor> · {elapsed(region.startedAt)}</Text>
      </Box>
      {wrappedTail.length > 0 && (
        <Box marginTop={0}>
          <PreWrappedText color={tailColor}>{wrappedTail}</PreWrappedText>
        </Box>
      )}
    </Box>
  );
}
