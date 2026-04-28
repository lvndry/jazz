import { Box, Text } from "ink";
import React from "react";
import { AnimatedEllipsis } from "./components/AnimatedEllipsis";
import type { RunStats } from "./store";
import { THEME } from "./theme";

/**
 * Format a USD cost for the status footer.
 *
 * - Below $0.01: 4 decimals so micro-runs aren't all "$0.00".
 * - Below $10: 3 decimals (`$0.042`, `$1.234`).
 * - $10+: 2 decimals (`$12.34`).
 */
function formatCost(cost: number): string {
  if (cost === 0) return "$0";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 10) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

/**
 * Format a token count compactly (e.g. "1.2k", "47k", "184k").
 */
function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

/**
 * Compress a path for footer display.
 *
 * - Replace home prefix with `~`.
 * - When too long, truncate the middle segment(s) so the basename and
 *   home anchor stay visible.
 */
function shortenPath(path: string, homeDir: string | undefined, maxWidth: number): string {
  let display = path;
  if (homeDir && display.startsWith(homeDir)) {
    display = "~" + display.slice(homeDir.length);
  }
  if (display.length <= maxWidth) return display;
  const segments = display.split("/");
  if (segments.length <= 3) {
    // Not much to compress — fall back to right-anchored truncation.
    return "..." + display.slice(display.length - (maxWidth - 3));
  }
  const head = segments[0] === "" ? "" : segments[0];
  const tail = segments.slice(-2).join("/");
  const compact = `${head}/.../${tail}`;
  if (compact.length <= maxWidth) return compact;
  return "..." + tail.slice(Math.max(0, tail.length - (maxWidth - 3)));
}

/**
 * Persistent bottom-of-screen status bar.
 *
 * Always visible during chat sessions when at least one field is
 * populated. Three slots: status (animated ellipsis when the agent is
 * working), run stats (model · tokens · cost), and working directory.
 *
 * Layout uses `space-between` so stats hug the right of the box and
 * status hugs the left. The middle is intentionally elastic so long
 * model names don't push other slots off-screen.
 */
function StatusFooter({
  status,
  workingDirectory,
  runStats,
}: {
  status: string | null;
  workingDirectory: string | null;
  runStats: RunStats;
}) {
  const hasRunStats =
    runStats.model !== undefined ||
    runStats.tokensInContext !== undefined ||
    runStats.costUSD !== undefined;
  const hasContent = status || workingDirectory || hasRunStats;
  if (!hasContent) return null;

  const homeDir = process.env["HOME"];
  const wd = workingDirectory ? shortenPath(workingDirectory, homeDir, 40) : null;

  // Build the compact stats line: "model · 12.3k/200k · $0.042"
  const statParts: string[] = [];
  if (runStats.model) statParts.push(runStats.model);
  if (runStats.tokensInContext !== undefined) {
    if (runStats.maxContextTokens) {
      statParts.push(
        `${formatTokens(runStats.tokensInContext)}/${formatTokens(runStats.maxContextTokens)}`,
      );
    } else {
      statParts.push(formatTokens(runStats.tokensInContext));
    }
  }
  if (runStats.costUSD !== undefined) statParts.push(formatCost(runStats.costUSD));
  // ASCII separator survives any font.
  const statLine = statParts.join(" · ");

  return (
    <Box
      marginTop={1}
      borderStyle="round"
      borderColor={THEME.borderSoft}
      paddingX={1}
      paddingY={0}
      flexDirection="row"
      justifyContent="space-between"
      width="100%"
    >
      <Box flexShrink={1}>
        {status ? (
          <AnimatedEllipsis
            label={status}
            color={THEME.primary}
          />
        ) : statLine.length > 0 ? (
          <Text dimColor>{statLine}</Text>
        ) : (
          <Text dimColor> </Text>
        )}
      </Box>
      <Box flexShrink={0}>{wd && <Text dimColor>{wd}</Text>}</Box>
    </Box>
  );
}

export default React.memo(StatusFooter);
